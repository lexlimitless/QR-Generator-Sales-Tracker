import { createClient } from '@supabase/supabase-js';
import { withAuth } from '../../../src/middleware/auth.js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function refreshYouTubeToken(refreshToken) {
  const params = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    client_secret: process.env.YOUTUBE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });

  if (!response.ok) {
    throw new Error('Failed to refresh YouTube token');
  }

  return await response.json(); // contains access_token, expires_in, etc.
}

async function handler(req, res) {
  const { userId } = req.auth;
  console.log('YouTube Videos API - userId:', userId);

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const offset = req.query.offset ? parseInt(req.query.offset) : 0;
    const limit = req.query.limit ? parseInt(req.query.limit) : 15;
    const youtubePageToken = req.query.youtubePageToken || null;
    console.log('YouTube Videos API - offset:', offset, 'limit:', limit);

    // Check if user has YouTube integration
    const { data: integration, error: integrationError } = await supabase
      .from('user_integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', 'youtube')
      .eq('is_connected', true)
      .single();

    console.log('YouTube Videos API - integration:', integration);
    console.log('YouTube Videos API - integrationError:', integrationError);

    if (integrationError || !integration) {
      return res.status(400).json({ 
        error: 'YouTube integration not connected',
        message: 'Please connect your YouTube account in the Integrations page to view your videos.'
      });
    }

    // --- Caching logic with offset-based pagination ---
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    let cachedVideos = [];
    let cacheIsFresh = false;
    let totalCachedCount = 0;

    console.log('YouTube Videos API - Starting cache check for user:', userId);

    // Check cache for all videos (to determine if cache is fresh)
    const { data: allVideosFromDb, error: allDbError } = await supabase
      .from('youtube_videos')
      .select('*')
      .eq('user_id', userId)
      .order('published_at', { ascending: false });

    // Get the stored next page token from user_integrations
    let storedNextPageToken = integration.youtube_next_page_token || null;

    console.log('YouTube Videos API - Database query result:', {
      totalVideosInDb: allVideosFromDb?.length || 0,
      dbError: allDbError,
      requestedOffset: offset,
      requestedLimit: limit
    });

    if (!allDbError && allVideosFromDb && allVideosFromDb.length > 0) {
      // Check if all videos are fresh (fetched_at within last hour)
      const freshVideos = allVideosFromDb.filter(v => v.fetched_at && new Date(v.fetched_at) > oneHourAgo);
      const staleVideos = allVideosFromDb.filter(v => !v.fetched_at || new Date(v.fetched_at) <= oneHourAgo);
      
      console.log('YouTube Videos API - Cache freshness check:', {
        totalVideos: allVideosFromDb.length,
        freshVideos: freshVideos.length,
        staleVideos: staleVideos.length,
        cacheIsFresh: freshVideos.length === allVideosFromDb.length
      });

      cacheIsFresh = freshVideos.length === allVideosFromDb.length;
      totalCachedCount = allVideosFromDb.length;
      
      if (cacheIsFresh) {
        const startIndex = offset;
        const endIndex = offset + limit;
        cachedVideos = allVideosFromDb.slice(startIndex, endIndex);
        // Debug: log offset, totalCachedCount, nextPageToken at end of list
        if (startIndex >= allVideosFromDb.length && !storedNextPageToken) {
          console.log('[DEBUG] End of list: offset', offset, 'totalCachedCount', allVideosFromDb.length, 'nextPageToken', storedNextPageToken);
          console.log('[DEBUG] Returning empty array and hasMore: false');
          return res.status(200).json({
            videos: [],
            offset: offset,
            nextOffset: null,
            hasMore: false,
            totalResults: allVideosFromDb.length,
            cached: true,
            youtubePageToken: null,
          });
        }
        if (cachedVideos.length === limit || endIndex <= allVideosFromDb.length) {
          const formattedVideos = cachedVideos.map(video => ({
            id: video.youtube_video_id,
            title: video.title,
            description: video.description,
            thumbnail_url: video.thumbnail_url,
            published_at: video.published_at,
            view_count: video.view_count,
            like_count: video.like_count,
            comment_count: video.comment_count,
            duration: video.duration,
            channel_id: video.channel_id,
            channel_title: video.channel_title,
            privacyStatus: video.privacy_status || undefined,
          }));
          const hasMore = endIndex < totalCachedCount || !!storedNextPageToken;
          const nextOffset = endIndex < totalCachedCount ? endIndex : null;
          console.log('[DEBUG] Returning paginated cached videos:', {
            offset, endIndex, totalCachedCount, hasMore, nextOffset, videosReturned: formattedVideos.length
          });
          return res.status(200).json({
            videos: formattedVideos,
            offset: offset,
            nextOffset: nextOffset,
            hasMore: hasMore,
            totalResults: totalCachedCount,
            cached: true,
            youtubePageToken: storedNextPageToken,
          });
        }
      } else {
        console.log('YouTube Videos API - Cache is stale, will fetch from YouTube API');
      }
    } else {
      console.log('YouTube Videos API - No cached videos found or database error:', {
        hasVideos: !!allVideosFromDb,
        videoCount: allVideosFromDb?.length || 0,
        error: allDbError
      });
    }

    // --- Token refresh logic ---
    console.log('YouTube Videos API - Cache not fresh or empty, fetching from YouTube API');
    let accessToken = integration.provider_access_token;
    let expiresAt = integration.provider_token_expires_at ? new Date(integration.provider_token_expires_at) : null;

    // If token is expired or about to expire in the next 2 minutes
    if (!accessToken || (expiresAt && expiresAt < new Date(now.getTime() + 2 * 60 * 1000))) {
      if (!integration.provider_refresh_token) {
        return res.status(400).json({
          error: 'YouTube refresh token missing',
          message: 'Please reconnect your YouTube account in the Integrations page.'
        });
      }
      try {
        const tokenData = await refreshYouTubeToken(integration.provider_refresh_token);
        accessToken = tokenData.access_token;
        expiresAt = new Date(now.getTime() + tokenData.expires_in * 1000);

        // Update DB
        await supabase
          .from('user_integrations')
          .update({
            provider_access_token: accessToken,
            provider_token_expires_at: expiresAt.toISOString(),
          })
          .eq('user_id', userId)
          .eq('provider', 'youtube');
        console.log('YouTube Videos API - token refreshed');
      } catch (err) {
        console.error('YouTube Videos API - token refresh failed:', err);
        return res.status(400).json({
          error: 'YouTube token refresh failed',
          message: 'Please reconnect your YouTube account in the Integrations page.'
        });
      }
    }

    // --- Efficient YouTube API calls ---
    // 1. Get uploads playlist ID
    const channelsRes = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const channelsData = await channelsRes.json();
    if (!channelsRes.ok || !channelsData.items || !channelsData.items[0]) {
      return res.status(500).json({ error: 'Failed to fetch channel details', message: 'Could not get uploads playlist ID.' });
    }
    const uploadsPlaylistId = channelsData.items[0].contentDetails.relatedPlaylists.uploads;
    // 2. Fetch up to 50 videos from uploads playlist, using storedNextPageToken if provided
    let playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=50`;
    if (storedNextPageToken) {
      playlistUrl += `&pageToken=${storedNextPageToken}`;
    }
    const playlistRes = await fetch(playlistUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const playlistData = await playlistRes.json();
    if (!playlistRes.ok || !playlistData.items) {
      return res.status(500).json({ error: 'Failed to fetch playlist videos', message: 'Could not get videos from uploads playlist.' });
    }
    const nextPageToken = playlistData.nextPageToken || null;
    // Store or clear the nextPageToken in user_integrations
    await supabase.from('user_integrations').update({ youtube_next_page_token: nextPageToken }).eq('user_id', userId).eq('provider', 'youtube');
    const videos = playlistData.items.map(item => ({
      user_id: userId,
      youtube_video_id: item.contentDetails.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      thumbnail_url: item.snippet.thumbnails?.high?.url || '',
      published_at: item.contentDetails.videoPublishedAt,
      channel_id: item.snippet.channelId,
      channel_title: item.snippet.channelTitle,
      fetched_at: now.toISOString(),
      // privacy_status will be updated after fetching details
    }));
    // 3. Upsert these 50 videos into Supabase
    await supabase.from('youtube_videos').upsert(videos, { onConflict: 'user_id,youtube_video_id', ignoreDuplicates: false });

    // After upserting, re-query the cache for all videos for this user
    const { data: updatedVideosFromDb, error: updatedDbError } = await supabase
      .from('youtube_videos')
      .select('*')
      .eq('user_id', userId)
      .order('published_at', { ascending: false });

    if (updatedDbError || !updatedVideosFromDb) {
      return res.status(500).json({ error: 'Failed to re-query cached videos after upsert.' });
    }

    const startIndex = offset;
    const endIndex = offset + limit;
    const pagedVideos = updatedVideosFromDb.slice(startIndex, endIndex);
    const pagedVideoIds = pagedVideos.map(v => v.youtube_video_id).join(',');

    // Fetch detailed stats for the paged videos
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails,status&id=${pagedVideoIds}`;
    console.log('[DEBUG] Fetching detailed video stats from:', statsUrl);
    const statsRes = await fetch(statsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const statsData = await statsRes.json();
    if (!statsRes.ok || !statsData.items) {
      return res.status(500).json({ error: 'Failed to fetch video details', message: 'Could not get video stats.' });
    }
    // Map videoId to privacyStatus for upsert
    const privacyStatusMap = {};
    statsData.items.forEach(item => {
      privacyStatusMap[item.id] = item.status?.privacyStatus || undefined;
    });
    // Upsert privacy_status for each video
    for (const item of statsData.items) {
      await supabase.from('youtube_videos').update({ privacy_status: item.status?.privacyStatus || null }).eq('user_id', userId).eq('youtube_video_id', item.id);
    }
    const detailedVideos = statsData.items.map(item => {
      const privacyStatus = item.status?.privacyStatus || undefined;
      console.log('[DEBUG] Video', item.id, 'privacyStatus:', privacyStatus);
      return {
        id: item.id,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail_url: item.snippet.thumbnails?.high?.url || '',
        published_at: item.snippet.publishedAt,
        view_count: parseInt(item.statistics.viewCount) || 0,
        like_count: parseInt(item.statistics.likeCount) || 0,
        comment_count: parseInt(item.statistics.commentCount) || 0,
        duration: item.contentDetails.duration,
        channel_id: item.snippet.channelId,
        channel_title: item.snippet.channelTitle,
        privacyStatus,
      };
    });

    const totalCached = updatedVideosFromDb.length;
    const hasMore = endIndex < totalCached || !!nextPageToken;
    const nextOffset = endIndex < totalCached ? endIndex : null;

    return res.status(200).json({
      videos: detailedVideos,
      offset: offset,
      nextOffset: nextOffset,
      hasMore: hasMore,
      totalResults: totalCached,
      cached: true,
      youtubePageToken: nextPageToken || null,
    });

  } catch (error) {
    console.error('YouTube videos API error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
}

export default withAuth(handler); 