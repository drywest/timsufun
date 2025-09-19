// functions/api/live.ts
// GET /api/live?channel=UCxxxxxxxx
// -> { videoId: "..." }  or  { videoId: null }

import { Innertube } from "youtubei.js";

export const onRequestGet: PagesFunction = async (ctx) => {
  const { searchParams } = new URL(ctx.request.url);
  const channel = searchParams.get("channel");
  if (!channel) return new Response(JSON.stringify({ error: "Missing channel" }), { status: 400 });

  try {
    const yt = await Innertube.create({ location: "US" });
    const ch = await yt.getChannel(channel);

    // Try to find a "Live now" video from shelves/tabs
    let liveId: string | null = null;

    // 1) Try channel.featured content / live shelf
    const tabs: any[] = ch?.tabs ?? [];
    for (const tab of tabs) {
      const sec = tab?.content?.sections ?? [];
      for (const s of sec) {
        const items = s?.contents ?? [];
        for (const it of items) {
          const vid = it?.id || it?.video_id || it?.endpoint?.payload?.videoId;
          const isLive = !!(it?.is_live || it?.badges?.some?.((b: any) => /LIVE/i.test(b?.label || "")));
          if (isLive && vid) { liveId = vid; break; }
        }
        if (liveId) break;
      }
      if (liveId) break;
    }

    // 2) Fallback: search within channel for live
    if (!liveId) {
      const r = await yt.search("", { params: { channel_id: channel, features: ["Live"], type: "video" } as any });
      const first = (r as any)?.videos?.find?.((v: any) => v?.is_live);
      if (first?.id) liveId = first.id;
    }

    return new Response(JSON.stringify({ videoId: liveId ?? null }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ videoId: null, error: e?.message || "resolve-failed" }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
};
