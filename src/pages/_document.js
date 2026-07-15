import { Html, Head, Main, NextScript } from 'next/document'

/**
 * Custom document to inject global head/body snippets
 * (Awin ownership verification + TradeTracker PageTools).
 */
export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href="/favicon.ico" sizes="any" />
        {/* Awin publisher check: word "Awin" must appear in live page source. Invisible to visitors. */}
        <meta name="awin-site-verification" content="Awin" />
      </Head>
      <body>
        <Main />
        <NextScript />
        {/* TradeTracker PageTools: verification, link replacing, CleanLinking, EU cookie compliance */}
        {/* Keep in place for ongoing re-verification. */}
        <script
          type="text/javascript"
          dangerouslySetInnerHTML={{
            __html: `
              var _TradeTrackerTagOptions = {
                t: 'a',
                s: '505962',
                chk: '5247a5af4f1b505aa13bccabb66dfa4f',
                overrideOptions: {}
              };
              (function() {
                var tt = document.createElement('script'), s = document.getElementsByTagName('script')[0];
                tt.setAttribute('type', 'text/javascript');
                tt.setAttribute('src', (document.location.protocol == 'https:' ? 'https' : 'http') + '://tm.tradetracker.net/tag?t=' + _TradeTrackerTagOptions.t + '&s=' + _TradeTrackerTagOptions.s + '&chk=' + _TradeTrackerTagOptions.chk);
                s.parentNode.insertBefore(tt, s);
              })();
            `
          }}
        />
      </body>
    </Html>
  )
}
