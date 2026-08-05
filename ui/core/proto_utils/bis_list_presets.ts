import { Spec } from '../proto/common.js';

export interface BisListPresetEntry {
	spec: Spec;
	phase: number;
	source: string;
	label: string;
	path: string;
}

export interface BisListPresetManifest {
	source: string;
	sourceUrl: string;
	license: string;
	generatedAt: string;
	presets: BisListPresetEntry[];
}

let manifestPromise: Promise<BisListPresetManifest> | null = null;

export async function getBisListPresetManifest(): Promise<BisListPresetManifest> {
	if (!manifestPromise) {
		manifestPromise = fetch('/tbc/assets/bis_lists/index.json')
			.then(response => {
				if (!response.ok) {
					throw new Error(`Failed to load BiS list manifest: ${response.status} ${response.statusText}`);
				}
				return response.json();
			})
			.then(json => json as BisListPresetManifest);
	}
	return manifestPromise;
}

export function getPresetsForSpec(manifest: BisListPresetManifest, spec: Spec): BisListPresetEntry[] {
	return manifest.presets.filter(preset => preset.spec === spec).sort((a, b) => a.phase - b.phase);
}

export function getPresetSources(manifest: BisListPresetManifest): string[] {
	return Array.from(new Set(manifest.presets.map(preset => preset.source)));
}

export async function loadBisListPreset(preset: BisListPresetEntry): Promise<string> {
	const response = await fetch(`/tbc/assets/bis_lists/${preset.path}`);
	if (!response.ok) {
		throw new Error(`Failed to load preset ${preset.label}: ${response.status} ${response.statusText}`);
	}
	return response.text();
}
