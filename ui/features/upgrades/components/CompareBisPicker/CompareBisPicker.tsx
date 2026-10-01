import { useSavedGear } from '@features/gear/hooks/useSavedGear';
import i18n from '@i18n/config';
import { useSimHost } from '@sim/context/SimHostContext';
import { patchUpgradeState } from '@sim/settings/upgrade_settings';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { type DropdownOption, DropdownPicker } from '@ui-kit/DropdownPicker';
import { useMemo } from 'react';

import { useUpgradeState } from '../../hooks/useUpgradeState';
import { type BisReferenceOption, getPresetGearOptions } from '../../model/bis_reference';

const optionName = (option: BisReferenceOption): string => (option.kind === 'preset' ? option.label : option.name);

const sameOption = (a: BisReferenceOption | undefined, b: BisReferenceOption | undefined): boolean =>
	a === b || (a?.kind === b?.kind && !!a && !!b && optionName(a) === optionName(b));

/**
 * The compare-BiS toggle and its gear-set dropdown: preset gear sets and gear-tab
 * saved sets in two groups, keyed by the label the user picked (the stored name, so
 * a saved run round-trips to the same set).
 *
 * The saved-set side subscribes to its saved-data slot, so sets saved or renamed in
 * the gear tab show up without a page reload. A stored pick whose set no longer
 * exists shows the placeholder while keeping the stored name; the run warns about
 * it rather than silently dropping the choice.
 */
export const CompareBisPicker = () => {
	const host = useSimHost();
	const player = host.player;
	const compareBisEnabled = useUpgradeState(slice => slice.compareBisEnabled);
	const bisReferenceName = useUpgradeState(slice => slice.bisReferenceName);
	const bisReferenceIsPreset = useUpgradeState(slice => slice.bisReferenceIsPreset);
	const savedGear = useSavedGear();

	const options = useMemo<Array<DropdownOption<BisReferenceOption | undefined>>>(
		() => [
			{ value: undefined, label: i18n.t('common.none') },
			...getPresetGearOptions(host).map(({ label, preset }) => ({
				value: { kind: 'preset', label, preset } as BisReferenceOption,
				label,
				submenu: [i18n.t('upgrade_tab.settings.compare_bis.presets_group')],
			})),
			...savedGear.entries.map(({ name }) => ({
				value: { kind: 'saved', name } as BisReferenceOption,
				label: name,
				submenu: [i18n.t('upgrade_tab.settings.compare_bis.saved_group')],
			})),
		],
		[host, savedGear.entries],
	);

	const selected = bisReferenceName
		? options.find(option => option.value && (option.value.kind === 'preset') === bisReferenceIsPreset && optionName(option.value) === bisReferenceName)
				?.value
		: undefined;

	const setReference = (option: BisReferenceOption | undefined) =>
		patchUpgradeState(
			player,
			option
				? { bisReferenceName: optionName(option), bisReferenceIsPreset: option.kind === 'preset' }
				: { bisReferenceName: '', bisReferenceIsPreset: false },
			['settings'],
		);

	return (
		<div>
			<BooleanPicker
				modObject={player}
				config={{
					id: 'upgrade-compare-bis',
					label: i18n.t('upgrade_tab.settings.compare_bis.label'),
					labelTooltip: i18n.t('upgrade_tab.settings.compare_bis.tooltip'),
					layout: 'inline',
					value: compareBisEnabled,
					onChange: (newValue: boolean) => patchUpgradeState(player, { compareBisEnabled: newValue }, ['settings']),
				}}
			/>
			{compareBisEnabled && (
				<DropdownPicker
					className="mt-2"
					testId="upgrade-bis-reference-select"
					options={options}
					value={selected}
					onChange={setReference}
					equals={sameOption}
					defaultLabel={i18n.t('upgrade_tab.settings.compare_bis.select_placeholder')}
				/>
			)}
		</div>
	);
};
