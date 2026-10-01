import { ItemDetailCell } from '@features/gear/components/ItemCell';
import { ItemSource } from '@features/gear/components/SelectorModal/ItemSource';
import { Exporter } from '@features/import-export';
import i18n from '@i18n/config';
import { translateSlotName } from '@i18n/localization';
import { useSimHost } from '@sim/context/SimHostContext';
import { patchUpgradeState, upgradeState } from '@sim/settings/upgrade_settings';
import type { UpgradeGearResult, UpgradeResult } from '@sim/upgrade/types';
import { formatDeltaText, formatToNumber } from '@sim/utils/format';
import { Button } from '@ui-kit/Button';
import { Dialog } from '@ui-kit/Dialog';
import { Icon } from '@ui-kit/Icon';
import { useActivateTab } from '@ui-kit/tab_activation';
import { toastManager } from '@ui-kit/Toast';
import clsx from 'clsx';
import { useState } from 'react';

import { useUpgradeState } from '../../hooks/useUpgradeState';
import { UPGRADE_ADDON_EXPORTER } from '../../model/addon_export';
import { getDisplayedUpgradeResults, isUpgradeRunningGuard } from '../../model/items';

const toneClass = (tone: ReturnType<typeof formatDeltaText>['tone']) => clsx((tone === 'positive' && 'text-success') || (tone === 'negative' && 'text-danger'));

/** The slots that differ between the baseline gear and a result gear, as diff rows. */
const GearDiffDialog = ({ result, onOpenChange }: { result: UpgradeResult | null; onOpenChange: (open: boolean) => void }) => {
	const baselineGear = useUpgradeState(slice => slice.baseline)?.gear;
	if (!result || !baselineGear) return null;

	const rows = result.gear
		.getItemSlots()
		.map(slot => ({ slot, baseline: baselineGear.getEquippedItem(slot), candidate: result.gear.getEquippedItem(slot) }))
		.filter(({ baseline, candidate }) => {
			if (!baseline && !candidate) return false;
			return !baseline || !candidate || !baseline.equals(candidate);
		});

	return (
		<Dialog
			open
			onOpenChange={onOpenChange}
			size="xl"
			scrollContents
			title={i18n.t('upgrade_tab.results.gear_diff_title', { itemName: result.item.item.name })}
			testId="upgrade-gear-diff-modal">
			<div className="grid gap-2" data-testid="upgrade-gear-diff-body">
				{rows.length === 0 && <div data-testid="upgrade-gear-diff-empty">{i18n.t('upgrade_tab.results.gear_diff_empty')}</div>}
				{rows.map(({ slot, baseline, candidate }) => (
					<div className="grid grid-cols-[auto_1fr_auto_1fr] items-center gap-2" key={slot} data-testid="upgrade-gear-diff-row">
						<div className="text-sm font-bold">{translateSlotName(slot)}</div>
						{/* The diff cells are read-only: the baseline item is not a picker target. */}
						<ItemDetailCell slot={slot} item={baseline} />
						<div aria-hidden>→</div>
						<ItemDetailCell slot={slot} item={candidate} />
					</div>
				))}
			</div>
		</Dialog>
	);
};

export const UpgradeResults = () => {
	const baseline = useUpgradeState(slice => slice.baseline);
	const bisResult = useUpgradeState(slice => slice.bisResult);
	const bisReferenceName = useUpgradeState(slice => slice.bisReferenceName);
	const results = useUpgradeState(slice => slice.results);
	const [diffResult, setDiffResult] = useState<UpgradeResult | null>(null);
	const [exportOpen, setExportOpen] = useState(false);

	const canExport = !!results?.length && !!baseline;

	return (
		<>
			<div className="mb-2 flex" data-testid="upgrade-results-toolbar">
				<Button
					size="sm"
					variant="secondary"
					disabled={!canExport}
					title={canExport ? undefined : i18n.t('upgrade_tab.results.export_addon_tooltip_disabled')}
					onClick={() => setExportOpen(true)}>
					<Icon name="file-arrow-up" style="base" className="mr-1" /> {i18n.t('upgrade_tab.results.export_addon_button')}
				</Button>
			</div>
			{!results || !baseline ? (
				<div data-testid="upgrade-results-placeholder">{i18n.t('upgrade_tab.results.run_simulation')}</div>
			) : (
				<UpgradeResultsTable
					baseline={baseline}
					bisResult={bisResult}
					bisReferenceName={bisReferenceName}
					results={results}
					onShowDiff={setDiffResult}
				/>
			)}
			{diffResult && <GearDiffDialog result={diffResult} onOpenChange={() => setDiffResult(null)} />}
			<Exporter open={exportOpen} onOpenChange={setExportOpen} {...UPGRADE_ADDON_EXPORTER} />
		</>
	);
};

interface UpgradeResultsTableProps {
	baseline: UpgradeGearResult;
	bisResult: UpgradeGearResult | null;
	bisReferenceName: string;
	results: Array<UpgradeResult>;
	onShowDiff: (result: UpgradeResult) => void;
}

// A row's vs-BiS cell: bisDelta is the candidate-on-reference DPS minus the reference;
// the formatter wants before/after, so reconstruct them around the reference average.
const BisDeltaCell = ({ bisResult, result }: { bisResult: UpgradeGearResult; result: UpgradeResult }) => {
	if (result.bisDelta === undefined) return <td />;
	const delta = formatDeltaText(bisResult.dpsMetrics.avg, bisResult.dpsMetrics.avg + result.bisDelta, 2, undefined, false, true);
	return (
		<td className={toneClass(delta.tone)} data-testid="upgrade-result-bis-delta">
			{delta.text}
		</td>
	);
};

const UpgradeResultsTable = ({ baseline, bisResult, bisReferenceName, results, onShowDiff }: UpgradeResultsTableProps) => {
	const host = useSimHost();
	const player = host.player;
	const activateTab = useActivateTab();

	const baselineAvg = baseline.dpsMetrics.avg;
	const displayed = getDisplayedUpgradeResults(results);
	const bisReferenceDelta = bisResult ? formatDeltaText(baselineAvg, bisResult.dpsMetrics.avg, 2, undefined, false, true) : null;

	const removeResult = (result: UpgradeResult) => {
		if (isUpgradeRunningGuard(player)) return;
		const resultItemId = result.item.item.id;
		const { candidates } = upgradeState(player);
		const index = candidates.findIndex(candidate => candidate.spec.id === resultItemId);
		if (index === -1) return;
		const removed = candidates[index];
		patchUpgradeState(
			player,
			{
				candidates: candidates.filter(candidate => candidate.spec.id !== resultItemId),
				results: results.filter(r => r.item.item.id !== resultItemId),
			},
			['settings', 'results'],
		);
		toastManager.add({ variant: 'success', body: i18n.t('upgrade_tab.results.item_removed', { itemName: removed.equippedItem.item.name }) });
	};

	return (
		<table className="table" data-testid="upgrade-results-table">
			<thead>
				<tr>
					<th>{i18n.t('upgrade_tab.results.rank')}</th>
					<th>{i18n.t('upgrade_tab.results.item')}</th>
					<th>{i18n.t('upgrade_tab.results.slot')}</th>
					<th>{i18n.t('upgrade_tab.results.dps')}</th>
					<th>{i18n.t('upgrade_tab.results.delta')}</th>
					{bisResult && <th>{i18n.t('upgrade_tab.results.delta_vs_bis')}</th>}
					<th>{i18n.t('upgrade_tab.results.source')}</th>
					<th>{i18n.t('upgrade_tab.results.action')}</th>
				</tr>
			</thead>
			<tbody>
				{displayed.map((result, index) => {
					const delta = formatDeltaText(baselineAvg, result.dpsMetrics.avg, 2, undefined, false, true);
					return (
						<tr key={`${result.item.item.id}-${result.slot}`} data-testid="upgrade-result-row">
							<td>{index + 1}</td>
							<td>
								<ItemDetailCell slot={result.slot} item={result.item} />
							</td>
							<td>{translateSlotName(result.slot)}</td>
							<td>{formatToNumber(result.dpsMetrics.avg)}</td>
							<td className={toneClass(delta.tone)} data-testid="upgrade-result-delta">
								{delta.text}
							</td>
							{bisResult && <BisDeltaCell bisResult={bisResult} result={result} />}
							<td>
								<ItemSource item={result.item.item} sim={host.sim} />
							</td>
							<td>
								<Button
									size="sm"
									onClick={() => {
										player.setGear(result.gear);
										activateTab('gear-tab');
										toastManager.add({ variant: 'success', body: i18n.t('upgrade_tab.results.gear_equipped') });
									}}>
									{i18n.t('upgrade_tab.results.equip_button')}
								</Button>
								<Button size="sm" variant="secondary" className="ml-1" onClick={() => onShowDiff(result)}>
									{i18n.t('upgrade_tab.results.diff_button')}
								</Button>
								<Button
									size="sm"
									variant="danger"
									className="ml-1"
									iconOnly
									title={i18n.t('upgrade_tab.results.remove_tooltip')}
									aria-label={i18n.t('upgrade_tab.results.remove_tooltip')}
									onClick={() => removeResult(result)}>
									<Icon name="times" />
								</Button>
							</td>
						</tr>
					);
				})}
				<tr className="font-bold" data-testid="upgrade-results-baseline">
					<td colSpan={2}>
						<strong>{i18n.t('upgrade_tab.results.current_gear')}</strong>
					</td>
					<td />
					<td>{formatToNumber(baselineAvg)}</td>
					<td colSpan={bisResult ? 4 : 3} />
				</tr>
				{bisResult && bisReferenceDelta && (
					<tr className="font-bold" data-testid="upgrade-results-bis-reference">
						<td colSpan={2}>
							<strong>{i18n.t('upgrade_tab.results.bis_reference_row', { name: bisReferenceName })}</strong>
						</td>
						<td />
						<td>{formatToNumber(bisResult.dpsMetrics.avg)}</td>
						<td className={toneClass(bisReferenceDelta.tone)}>{bisReferenceDelta.text}</td>
						<td colSpan={3} />
					</tr>
				)}
			</tbody>
		</table>
	);
};
