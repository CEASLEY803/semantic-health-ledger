import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    // In WSL2: both Next.js and FastAPI run on localhost, so this proxy is a
    // clean alternative to setting NEXT_PUBLIC_API_URL in .env.local.
    return [
      {
        source: '/api/v1/:path*',
        destination: 'http://localhost:8787/api/v1/:path*',
      },
    ];
  },
};

export default nextConfig;
