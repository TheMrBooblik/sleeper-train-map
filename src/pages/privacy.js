import Head from "next/head";
import Link from "next/link";
import SeoLayout from "../components/seo/SeoLayout";
import { SITE_URL } from "../lib/seo/site";

// Placeholder contact — replace with the address you want to publish for
// privacy requests (see the note in the "Contact us" section below).
const CONTACT_EMAIL = "privacy@pingwi.com";
const LAST_UPDATED = "24 July 2026";

/** A titled policy section with a subtle divider, matching the dark SEO theme. */
const PolicySection = ({ title, children }) => (
  <section className="mt-10 border-t border-white/10 pt-8">
    <h2 className="text-xl sm:text-2xl font-semibold text-white">{title}</h2>
    <div className="mt-4 space-y-4 text-sm sm:text-base leading-relaxed text-white/60">
      {children}
    </div>
  </section>
);

/** Reusable inline link styled to the site accent colour. */
const A = ({ href, children }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    className="text-primary-green hover:text-primary-green-light underline underline-offset-2"
  >
    {children}
  </a>
);

export default function PrivacyPage() {
  return (
    <>
      <Head>
        <title>Privacy Policy | Pingwi Sleeper Train Map</title>
        <meta
          name="description"
          content="How Pingwi's Sleeper Train Map handles your data: a GDPR-oriented privacy policy covering analytics, cookies, affiliate links, third-party services and your rights."
        />
        <link rel="canonical" href={`${SITE_URL}/privacy`} />
        <meta property="og:title" content="Privacy Policy | Pingwi Sleeper Train Map" />
        <meta
          property="og:description"
          content="How Pingwi's Sleeper Train Map handles your data and your rights under the GDPR."
        />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={`${SITE_URL}/privacy`} />
        <meta property="og:site_name" content="Pingwi Sleeper Train Map" />
      </Head>

      <SeoLayout>
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-28 sm:pt-32 pb-16">
          <header>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">
              Privacy Policy
            </h1>
            <p className="mt-3 text-sm text-white/40">Last updated: {LAST_UPDATED}</p>
            <p className="mt-6 text-sm sm:text-base leading-relaxed text-white/60">
              This policy explains what personal data the Sleeper Train Map
              collects, why, and what rights you have. We have deliberately kept
              the site lightweight: it does not sell tickets, does not process
              payments, and does not ask you to create an account.
            </p>
          </header>

          <PolicySection title="Who we are">
            <p>
              The Sleeper Train Map (
              <A href={SITE_URL}>pingwi.com</A>) is an
              independent travel-discovery website operated by{" "}
              <strong className="text-white/80">Pingwi</strong>, a business
              registered in the Netherlands. For the purposes of the EU General
              Data Protection Regulation (GDPR), Pingwi is the “data controller”
              for the limited personal data described below.
            </p>
            <p>
              You can reach us about anything in this policy at{" "}
              <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>.
            </p>
          </PolicySection>

          <PolicySection title="What this website does">
            <p>
              The Sleeper Train Map is a free, interactive map of European (and
              some international) night and sleeper train routes. It helps you
              discover which overnight trains call at a station, see timetables
              and stops, and find where to book.
            </p>
            <p>
              We are a discovery and information tool only.{" "}
              <strong className="text-white/80">
                We do not sell tickets and we do not take payments.
              </strong>{" "}
              When you want to book, we link you out to the relevant railway
              operator’s own official website (for example ÖBB Nightjet,
              European Sleeper, Trenitalia and others). Any ticket purchase,
              account creation, or payment happens entirely on that third
              party’s platform and is governed by <em>their</em> terms and
              privacy policy, not ours.
            </p>
          </PolicySection>

          <PolicySection title="Accuracy of information">
            <p>
              We work hard to keep the map accurate — routes and timetables are
              refreshed regularly and community-submitted corrections are
              reviewed before they go live. Even so, train schedules, routes,
              stops, prices and availability change frequently and can contain
              errors or omissions. We therefore provide all information{" "}
              <strong className="text-white/80">
                “as is”, for general guidance only, with no warranty
              </strong>{" "}
              that it is complete, current or entirely accurate.
            </p>
            <p>
              Always confirm times, routes and prices directly with the relevant
              railway operator before planning or booking a journey. To the
              extent permitted by law, Pingwi is not liable for any loss or
              inconvenience arising from reliance on the information shown here.
              Spotted something wrong? Use “Suggest an edit” on any route — every
              report is reviewed.
            </p>
          </PolicySection>

          <PolicySection title="Affiliate links">
            <p>
              Some of the outbound booking links on this site are affiliate
              links, served through the affiliate networks{" "}
              <A href="https://www.tradetracker.com/">TradeTracker</A>,{" "}
              <A href="https://www.awin.com/">Awin</A> and{" "}
              <A href="https://www.effiliation.com/">Effiliation</A>. If you
              follow one of these links and later make a booking, we may earn a
              small commission from the operator — at no extra cost to you. This
              helps cover the cost of running the site. Affiliate relationships
              never change which routes we show or how they are ranked.
            </p>
            <p>
              To attribute a booking, these networks may set their own cookies
              in your browser when you click through to an operator. See{" "}
              <em>Cookies and local storage</em> below.
            </p>
          </PolicySection>

          <PolicySection title="What personal data we collect">
            <p>We keep data collection to a minimum. Specifically:</p>
            <ul className="list-disc pl-5 space-y-3 marker:text-white/30">
              <li>
                <strong className="text-white/80">
                  Aggregate, privacy-friendly analytics.
                </strong>{" "}
                We use{" "}
                <A href="https://vercel.com/docs/analytics">
                  Vercel Web Analytics
                </A>{" "}
                and{" "}
                <A href="https://vercel.com/docs/speed-insights">
                  Vercel Speed Insights
                </A>{" "}
                to understand which pages are visited and how the site performs.
                These are cookieless and are designed not to identify individual
                visitors — they report anonymised, aggregated statistics (such as
                page views and load times), not personal profiles.
              </li>
              <li>
                <strong className="text-white/80">Server logs.</strong> Our
                hosting provider automatically processes standard technical
                request data (such as your IP address and browser user-agent) to
                deliver the site securely and to guard against abuse. This is
                ordinary web-server logging.
              </li>
              <li>
                <strong className="text-white/80">
                  Edit suggestions you choose to send.
                </strong>{" "}
                If you use the optional “Suggest an edit” form, we receive the
                message you write and, only if you choose to provide it, an email
                address for follow-up. To limit spam we also store a one-way
                <em> hashed</em> (irreversible) version of your IP address and
                your browser user-agent alongside the suggestion. Providing an
                email is entirely optional.
              </li>
            </ul>
            <p>
              We do not run advertising trackers, we do not build marketing
              profiles, and we do not sell personal data to anyone.
            </p>
          </PolicySection>

          <PolicySection title="Cookies and local storage">
            <p>
              The Sleeper Train Map does not set any first-party analytics or
              advertising cookies. Our analytics (above) are cookieless.
            </p>
            <ul className="list-disc pl-5 space-y-3 marker:text-white/30">
              <li>
                <strong className="text-white/80">
                  Functional local storage.
                </strong>{" "}
                We store a few small preferences in your browser’s local storage
                (for example whether routes are shown, or whether you dismissed
                an info panel). This data stays on your device, is not sent to
                us as a cookie, and is used only to remember how you like the map
                to look.
              </li>
              <li>
                <strong className="text-white/80">Affiliate cookies.</strong>{" "}
                As noted above, our affiliate partners (TradeTracker, Awin and
                Effiliation) may set cookies to attribute a booking when you
                click an outbound link to an operator. These are governed by
                those networks’ own privacy and cookie policies. You can clear
                or block cookies at any time in your browser settings.
              </li>
            </ul>
          </PolicySection>

          <PolicySection title="Third-party services">
            <p>
              We rely on a small number of third parties to run the site. When
              you use the map, some of these may receive technical data such as
              your IP address as a normal part of serving content:
            </p>
            <ul className="list-disc pl-5 space-y-3 marker:text-white/30">
              <li>
                <A href="https://vercel.com/legal/privacy-policy">Vercel</A> —
                hosting, plus the cookieless analytics and speed-insights
                described above.
              </li>
              <li>
                <A href="https://www.openstreetmap.org/copyright">
                  OpenStreetMap
                </A>{" "}
                and{" "}
                <A href="https://www.openrailwaymap.org/">OpenRailwayMap</A> —
                the map background and optional railway overlay tiles.
              </li>
              <li>
                <A href="https://www.tradetracker.com/">TradeTracker</A>,{" "}
                <A href="https://www.awin.com/">Awin</A> and{" "}
                <A href="https://www.effiliation.com/">Effiliation</A> —
                affiliate link tracking for outbound booking links.
              </li>
              <li>
                <A href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">
                  GitHub
                </A>{" "}
                — where edit suggestions submitted through the form are stored
                for review.
              </li>
              <li>
                Railway operators and booking platforms you choose to visit via
                our outbound links (for example ÖBB Nightjet, European Sleeper,
                Trenitalia). Once you leave our site, their privacy policy
                applies.
              </li>
            </ul>
          </PolicySection>

          <PolicySection title="Legal basis for processing (GDPR)">
            <p>Where the GDPR applies, we rely on the following legal bases:</p>
            <ul className="list-disc pl-5 space-y-3 marker:text-white/30">
              <li>
                <strong className="text-white/80">Legitimate interests</strong>{" "}
                (Art. 6(1)(f)) — to keep the site secure, understand aggregate
                usage, and operate our affiliate links, in a way that is minimal
                and that we believe does not override your rights.
              </li>
              <li>
                <strong className="text-white/80">Consent</strong> (Art. 6(1)(a))
                — where you voluntarily send us a suggestion or your email
                address through the optional form.
              </li>
            </ul>
          </PolicySection>

          <PolicySection title="How long we keep data">
            <p>
              Aggregate analytics are retained by our provider in anonymised form
              and are not linked to you. Suggestions sent through the form are
              kept only as long as needed to review and act on them. You may ask
              us to delete a suggestion (and any email you provided) at any time.
            </p>
          </PolicySection>

          <PolicySection title="International transfers">
            <p>
              Some of our providers (for example Vercel and GitHub) are based
              in, or process data in, the United States. Where personal data is
              transferred outside the European Economic Area, those providers
              rely on appropriate safeguards such as the EU Standard Contractual
              Clauses.
            </p>
          </PolicySection>

          <PolicySection title="Your rights">
            <p>
              Under the GDPR you have the right to access, correct, delete,
              restrict or object to the processing of your personal data, and the
              right to data portability. Because we hold so little data — and
              nothing that identifies you unless you email us — these rights are
              usually straightforward to honour. To exercise any of them, contact
              us at <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>.
            </p>
            <p>
              If you are based in the EU and believe we have mishandled your
              data, you also have the right to lodge a complaint with your local
              data protection authority. In the Netherlands this is the{" "}
              <A href="https://www.autoriteitpersoonsgegevens.nl/en">
                Autoriteit Persoonsgegevens
              </A>
              .
            </p>
          </PolicySection>

          <PolicySection title="Contact us">
            <p>
              Questions about this policy or your data? Email{" "}
              <A href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</A>.
            </p>
          </PolicySection>

          <PolicySection title="Changes to this policy">
            <p>
              We may update this policy as the site evolves. When we do, we will
              revise the “Last updated” date at the top of this page. Material
              changes will be reflected here.
            </p>
          </PolicySection>

          <div className="mt-12 border-t border-white/10 pt-8">
            <Link
              href="/"
              className="text-sm text-primary-green hover:text-primary-green-light"
            >
              ← Back to the map
            </Link>
          </div>
        </div>
      </SeoLayout>
    </>
  );
}
