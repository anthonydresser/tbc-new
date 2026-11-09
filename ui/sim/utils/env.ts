// Which deployment this page is running as.

export type Environments = 'local' | 'external';

// Pure classification of a hostname. The browser probe that reads the actual
// page hostname lives in ui/ui-kit/utils/dom.ts; anything with an `Env` in hand
// (e.g. Sim) passes `env.location.hostname` here instead.
// Loopback hosts (including the desktop app's 127.0.0.1 origin) are always local.
export const environmentOf = (hostname: string): Environments =>
	hostname.includes('localhost') || hostname === '127.0.0.1' || hostname === '0.0.0.0' ? 'local' : 'external';
export const isDevMode = () => {
	return import.meta.env.DEV;
};
