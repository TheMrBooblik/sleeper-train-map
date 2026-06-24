const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('next').NextConfig} */

const nextConfig = {
  reactStrictMode: true,
  // The /sitemap.xml page runs in a request-time serverless function and reads the
  // committed data via fs (src/lib/seo/data.js). Next's file tracer can't follow that
  // dynamic read, so force these JSON files into the sitemap lambda — otherwise the
  // read throws ENOENT in production (works locally only because cwd is the repo root).
  outputFileTracingIncludes: {
    '/sitemap.xml': [
      './public/data/published/initial-data.json',
      './public/data/scraped/backontrack-stops.json',
    ],
  },
  webpack: (config) => {
    config.plugins.push(
      new CopyPlugin({
        patterns: [
          {
            from: 'node_modules/leaflet/dist/images',
            to: path.resolve(__dirname, 'public', 'leaflet', 'images')
          },
        ],
      }),
    )
    return config
  }
}

module.exports = nextConfig;