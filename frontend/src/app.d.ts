declare global {
  // Build-time constants, defined in vite.config.ts.
  const __APP_NAME__: string;
  const __APP_NAME_ARABIC__: string;
  const __API_URL__: string;
  const __SITE_URL__: string;
  const __ABUSE_EMAIL__: string;
  const __TURNSTILE_SITE_KEY__: string;

  namespace App {}
}

export {};
