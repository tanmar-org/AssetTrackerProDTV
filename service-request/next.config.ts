import type { NextConfig } from "next";

// Both applications run on Node. Keep build workers bounded for the hosting VM;
// native PostgreSQL uses server-only environment variables and connections.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  experimental: { cpus: 2 },
};
export default nextConfig;
