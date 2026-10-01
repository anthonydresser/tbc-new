import i18n from '@i18n/config';
import { usePlayer } from '@sim/context/SimHostContext';
import { type BisListPresetEntry, getBisListPresetManifest, getPresetsForSpec } from '@sim/upgrade/bis_list_presets';
import { Button } from '@ui-kit/Button';
import { DropdownPicker } from '@ui-kit/DropdownPicker';
import { Icon } from '@ui-kit/Icon';
import { useEffect, useState } from 'react';

import { loadPresetIntoCandidates } from '../../model/bis';

/**
 * The curated BiS lists for the current spec: a phase dropdown plus a load button.
 * The selection is UI-local state — nothing is written to the store until Load runs.
 * Renders nothing for specs the manifest has no lists for.
 */
export const BisPresetControls = () => {
	const player = usePlayer();
	const [presets, setPresets] = useState<BisListPresetEntry[]>([]);
	const [selected, setSelected] = useState<BisListPresetEntry | undefined>(undefined);

	useEffect(() => {
		let cancelled = false;
		getBisListPresetManifest()
			.then(manifest => {
				if (!cancelled) setPresets(getPresetsForSpec(manifest, player.getSpec()));
			})
			.catch(error => console.error('Failed to load BiS list presets:', error));
		return () => {
			cancelled = true;
		};
	}, [player]);

	if (!presets.length) return null;

	return (
		<div className="flex items-center gap-2" data-testid="bis-preset-controls">
			<span className="text-sm">{i18n.t('upgrade_tab.presets.label')}</span>
			<DropdownPicker
				testId="bis-preset-select"
				options={presets.map(preset => ({
					value: preset,
					label: i18n.t('upgrade_tab.presets.phase_option', { phase: preset.phase }),
				}))}
				value={selected}
				onChange={setSelected}
				equals={(a, b) => a?.path === b?.path}
				defaultLabel={i18n.t('upgrade_tab.presets.select_phase')}
			/>
			<Button
				variant="secondary"
				disabled={!selected}
				data-testid="bis-preset-load"
				onClick={() => selected && loadPresetIntoCandidates(player, selected)}>
				<Icon name="cloud-arrow-down" className="mr-1" /> {i18n.t('upgrade_tab.presets.load')}
			</Button>
		</div>
	);
};
