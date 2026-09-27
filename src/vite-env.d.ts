/// <reference types="vite/client" />

interface ImportMetaEnv {
    /** TomTom API key baked in at build time (see `.env.example`). Optional: visitors can enter their own. */
    readonly VITE_TOMTOM_API_KEY?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
