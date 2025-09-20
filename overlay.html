<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>YT Chat Overlay</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin:0; padding:0; height:100%; background:transparent; }
      * { font-family: "Segoe UI","Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",Tahoma,Geneva,Verdana,sans-serif !important; }

      :root{
        --line-gap:10px;
        --font-size:42px;
        --shadow:0 3px 0 rgba(0,0,0,.45), 0 10px 24px rgba(0,0,0,.28);
        --enter-ms:40ms;          /* new line micro fade/slide */
        --push-ms:140ms;          /* j-chat push-up */
        --emoji-scale:1.8;        /* <— tweak if you want them bigger/smaller */
        --max-keep:400;
      }

      .stack{
        position:absolute; inset:0;
        display:flex; flex-direction:column; justify-content:flex-end;
        padding:18px; gap:var(--line-gap);
        overflow:hidden;
        will-change: transform;
        transition: transform var(--push-ms) ease-out;
      }

      .line{
        display:block;
        font-size:var(--font-size);
        line-height:1.12;
        font-weight:900;
        letter-spacing:.2px;
        color:#fff !important;
        text-shadow:var(--shadow);
        white-space:normal; word-break:break-word;

        opacity:0; transform:translateY(8px);
        transition: transform var(--enter-ms) ease-out, opacity var(--enter-ms) ease-out;
      }
      .line.enter{ transform:translateY(0); opacity:1; }

      .author{ font-weight:900; margin-right:.25em; }
      .message{ font-weight:900; color:#fff !important; }

      /* YouTube emoji <img> */
      .emoji{ height:1em; vertical-align:-0.15em; display:inline-block; }

      /* Native (Unicode) emoji wrapped by JS → perfectly matches visual height */
      .emoji-char{
        display:inline-block;
        width:1em;               /* reserve layout width */
        height:1em;              /* baseline height reference */
        line-height:1;
        font-size:1em;           /* base before scaling */
        font-weight:400;         /* avoid bold inflation */
        font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji";
        transform: translateY(0.06em) scale(var(--emoji-scale));
        transform-origin: left bottom;
        vertical-align:-0.25em;
        /* prevent overlap with following text when scaled wider than 1em */
        margin-right: calc((var(--emoji-scale) - 1) * 1em);
      }
    </style>
  </head>
  <body>
    <div id="stack" class="stack"></div>
    <script src="/overlay.js"></script>
  </body>
</html>
