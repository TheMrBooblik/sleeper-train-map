import Head from "next/head";
import Link from "next/link";
import { FaTrain, FaMapMarkerAlt, FaMoon, FaArrowRight } from "react-icons/fa";
import { COUNTRIES, getFlagEmoji } from "../lib/countries";

const FeatureCard = ({ icon: Icon, title, description }) => (
  <div className="flex flex-col items-start gap-4 p-6 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] transition-colors">
    <div className="flex items-center justify-center w-12 h-12 rounded-lg bg-primary-green/20">
      <Icon className="w-5 h-5 text-primary-green" />
    </div>
    <div>
      <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
      <p className="text-sm text-white/60 leading-relaxed">{description}</p>
    </div>
  </div>
);

const CountryCard = ({ code, name }) => (
  <Link
    href={`/?country=${code}`}
    className="group flex items-center gap-3 p-4 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-white/[0.05] hover:border-primary-green/50 transition-all"
  >
    <span className="text-2xl">{getFlagEmoji(code)}</span>
    <span className="text-sm font-medium text-white/80 group-hover:text-white transition-colors">
      {name}
    </span>
    <FaArrowRight className="w-3 h-3 text-white/30 group-hover:text-primary-green ml-auto transition-colors shrink-0" />
  </Link>
);

const ASIA_COUNTRY_CODES = new Set(["CN"]);

const StepCard = ({ number, title, description }) => (
  <div className="flex gap-4 items-start">
    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-primary-green/20 flex items-center justify-center">
      <span className="text-primary-green font-bold">{number}</span>
    </div>
    <div>
      <h3 className="text-base font-semibold text-white mb-1">{title}</h3>
      <p className="text-sm text-white/60 leading-relaxed">{description}</p>
    </div>
  </div>
);

export default function AboutPage() {
  const europeCountries = COUNTRIES.filter(
    (country) => !ASIA_COUNTRY_CODES.has(country.code),
  );
  const asiaCountries = COUNTRIES.filter((country) =>
    ASIA_COUNTRY_CODES.has(country.code),
  );

  return (
    <>
      <Head>
        <title>
          About | Pingwi Sleeper Train Map - European Night Train Routes
        </title>
        <meta
          name="description"
          content="Discover Europe by night train. Interactive map of all European sleeper train routes - click any station to see departures. Covering 24+ countries from Portugal to Ukraine."
        />
        <meta
          name="keywords"
          content="sleeper train map, night train Europe, European sleeper trains, overnight train routes, train travel Europe"
        />
        <link
          rel="canonical"
          href="https://sleeper-train-map.pingwi.com/about"
        />

        {/* Open Graph */}
        <meta
          property="og:title"
          content="Pingwi Sleeper Train Map - European Night Train Routes"
        />
        <meta
          property="og:description"
          content="Interactive map of all European sleeper train routes. Click any station to discover overnight connections across 24+ countries."
        />
        <meta property="og:type" content="website" />
        <meta
          property="og:url"
          content="https://sleeper-train-map.pingwi.com/about"
        />

        {/* Twitter */}
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Pingwi Sleeper Train Map" />
        <meta
          name="twitter:description"
          content="Interactive map of all European sleeper train routes. Discover overnight connections across 24+ countries."
        />

        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚂</text></svg>"
        />
      </Head>

      <div className="h-screen overflow-y-auto bg-black">
        {/* Navigation */}
        <nav className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-md border-b border-white/10">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex items-center justify-between h-16">
              <Link
                href="/about"
                className="text-white font-medium hover:text-primary-green transition-colors"
              >
                Pingwi{" "}
                <span className="italic text-primary-green">sleeper train</span>{" "}
                map
              </Link>
              <Link
                href="/"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary-green hover:bg-primary-green-light text-black font-medium text-sm transition-colors"
              >
                Open Map
                <FaArrowRight className="w-3 h-3" />
              </Link>
            </div>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto text-center">
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-white tracking-tight text-balance">
              Discover Europe by
              <span className="text-primary-green"> Night Train</span>
            </h1>
            <p className="mt-6 text-lg sm:text-xl text-white/60 max-w-2xl mx-auto leading-relaxed text-pretty">
              The interactive map for spontaneous travel. Click any station -
              from major cities to small towns - and see every sleeper train
              departure at a glance.
            </p>
            <div className="mt-10 flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                href="/"
                className="inline-flex items-center gap-2 px-8 py-4 rounded-full bg-primary-green hover:bg-primary-green-light text-black font-semibold text-base transition-colors"
              >
                Explore the Map
                <FaArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="#countries"
                className="inline-flex items-center gap-2 px-8 py-4 rounded-full border border-white/20 hover:border-white/40 text-white font-medium text-base transition-colors"
              >
                View All Countries
              </a>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section className="py-20 px-4 sm:px-6 lg:px-8 border-t border-white/10">
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-12">
              <h2 className="text-2xl sm:text-3xl font-bold text-white">
                Travel spontaneously
              </h2>
              <p className="mt-4 text-white/60 max-w-xl mx-auto">
                No more searching through multiple booking sites. See all your
                options in one place.
              </p>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
              <FeatureCard
                icon={FaMapMarkerAlt}
                title="Click Any Station"
                description="Select any station on the map - from Berlin Hauptbahnhof to a small Czech town - and instantly see all sleeper trains passing through."
              />
              <FeatureCard
                icon={FaTrain}
                title="All Routes Visible"
                description="View the complete network of European night trains. Filter by specific routes or explore the full map of overnight connections."
              />
              <FeatureCard
                icon={FaMoon}
                title="Travel While You Sleep"
                description="Wake up in a new city. Night trains combine transportation and accommodation, saving you time and money on hotels."
              />
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="py-20 px-4 sm:px-6 lg:px-8 border-t border-white/10">
          <div className="max-w-3xl mx-auto">
            <div className="text-center mb-12">
              <h2 className="text-2xl sm:text-3xl font-bold text-white">
                How it works
              </h2>
            </div>
            <div className="space-y-8">
              <StepCard
                number="1"
                title="Find your starting point"
                description="Navigate the map or search for your city. Every dot represents a station with sleeper train connections."
              />
              <StepCard
                number="2"
                title="Click to see departures"
                description="Select a station to reveal all night train routes passing through. See destination cities and route details."
              />
              <StepCard
                number="3"
                title="Book your journey"
                description="Found your route? Follow the links to official booking sites. We show you the options, you choose your adventure."
              />
            </div>
          </div>
        </section>

        {/* Countries Grid */}
        <section
          id="countries"
          className="py-20 px-4 sm:px-6 lg:px-8 border-t border-white/10"
        >
          <div className="max-w-6xl mx-auto">
            <div className="text-center mb-12">
              <h2 className="text-2xl sm:text-3xl font-bold text-white">
                Covering {COUNTRIES.length}+ countries
              </h2>
              <p className="mt-4 text-white/60 max-w-xl mx-auto">
                Click any country to jump directly to that region on the map
              </p>
            </div>
            <h3 className="text-lg font-semibold text-white mb-4">Europe</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {europeCountries.map((country) => (
                <CountryCard key={country.code} {...country} />
              ))}
            </div>
            {asiaCountries.length > 0 && (
              <>
                <h3 className="text-lg font-semibold text-white mt-10 mb-4">
                  Asia
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {asiaCountries.map((country) => (
                    <CountryCard key={country.code} {...country} />
                  ))}
                </div>
              </>
            )}
          </div>
        </section>

        {/* CTA Section */}
        <section className="py-20 px-4 sm:px-6 lg:px-8 border-t border-white/10">
          <div className="max-w-3xl mx-auto text-center">
            <h2 className="text-2xl sm:text-3xl font-bold text-white">
              Ready to explore?
            </h2>
            <p className="mt-4 text-white/60">
              Start planning your next overnight adventure across Europe.
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-2 mt-8 px-8 py-4 rounded-full bg-primary-green hover:bg-primary-green-light text-black font-semibold text-base transition-colors"
            >
              Open the Map
              <FaArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </section>

        {/* Footer */}
        <footer className="py-8 px-4 sm:px-6 lg:px-8 border-t border-white/10">
          <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-sm text-white/40">Pingwi Sleeper Train Map</p>
            <nav className="flex items-center gap-6">
              <Link
                href="/"
                className="text-sm text-white/40 hover:text-white/70 transition-colors"
              >
                Map
              </Link>
              <Link
                href="/about"
                className="text-sm text-white/40 hover:text-white/70 transition-colors"
              >
                About
              </Link>
            </nav>
          </div>
        </footer>
      </div>

      {/* JSON-LD Structured Data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebApplication",
            name: "Pingwi Sleeper Train Map",
            description:
              "Interactive map of European sleeper train routes. Click any station to discover overnight train connections across 24+ countries.",
            url: "https://sleeper-train-map.pingwi.com",
            applicationCategory: "TravelApplication",
            operatingSystem: "Web Browser",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "EUR",
            },
            aggregateRating: {
              "@type": "AggregateRating",
              ratingValue: "4.8",
              ratingCount: "150",
            },
          }),
        }}
      />
    </>
  );
}
