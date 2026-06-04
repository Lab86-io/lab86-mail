import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['lab86.tail478321.ts.net'],
  experimental: {
    serverActions: {
      bodySizeLimit: '4mb',
    },
  },
  serverExternalPackages: ['@seald-io/nedb', 'mailparser'],
  // Long-running SSE responses
  poweredByHeader: false,
};

export default config;
