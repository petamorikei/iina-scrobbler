// Values injected at build time (build.mjs). Kept in one module so the rest of the code
// does not reference the define()d globals directly.
export const LASTFM_API_KEY: string = __LASTFM_API_KEY__;
export const LASTFM_API_SECRET: string = __LASTFM_API_SECRET__;
export const HAS_LASTFM_CREDENTIALS = LASTFM_API_KEY !== "" && LASTFM_API_SECRET !== "";
