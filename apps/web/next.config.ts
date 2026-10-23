import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@liara-agent/shared"],
  poweredByHeader: false,
};

export default config;
