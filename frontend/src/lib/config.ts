/** The product name. Set once in /brand.json, or with APP_NAME at build time. */
export const APP_NAME = __APP_NAME__;
export const APP_NAME_ARABIC = __APP_NAME_ARABIC__;
/** Public API origin, e.g. https://sayl-api.kitaaura.com */
export const API_URL = __API_URL__.replace(/\/+$/, '');
/** This site's own origin, for canonical links and the share image. */
export const SITE_URL = __SITE_URL__.replace(/\/+$/, '');
export const ABUSE_EMAIL = __ABUSE_EMAIL__;
export const TURNSTILE_SITE_KEY = __TURNSTILE_SITE_KEY__;
/** 'browser': torrents run in the visitor's browser through their relay. 'server': a self-hosted backend runs them. */
export const ENGINE = __ENGINE__;
export const BROWSER_ENGINE = ENGINE === 'browser';
export const DESCRIPTION = BROWSER_ENGINE
  ? `${APP_NAME} downloads torrents right in your browser. paste a magnet link or drop a .torrent, pick files, save them. free, no install.`
  : `${APP_NAME} downloads torrents on a server and hands you the files over https. paste a magnet link or drop a .torrent, pick files, download.`;
