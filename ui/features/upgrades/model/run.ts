// The upgrade finder's sim loop: one baseline sim of the worn gear, then one sim per
// candidate per slot it fits (the best slot wins the row). Gem optimization is the
// optional reforge pre-pass per candidate, like bulk's. With a BiS reference set
// selected, the loop also sims the reference set and swaps every candidate into it.
import { EquipmentSpec, type ItemSlot } from '@generated/proto/common';
import i18n from '@i18n/config';
import type { Gear } from '@sim/proto/gear';
import { frozenGemSocketSet } from '@sim/proto/items';
import { patchUpgradeState, storeUpgradeRunState, upgradeState } from '@sim/settings/upgrade_settings';
import type { IndividualSimHost } from '@sim/sim_host';
import { RequestTypes } from '@sim/sim_signal_manager';
import type { UpgradeCandidate, UpgradeGearResult, UpgradeResult } from '@sim/upgrade/types';
import { toastManager } from '@ui-kit/Toast';

import { trackEvent } from '../../../tracking/utils';
import { resolveBisReferenceGear } from './bis_reference';
import { getDefaultGemsByColor, upgradeEligibleSlots } from './items';

export interface UpgradeProgress {
	stage: string;
	title: string;
	current: number;
	total: number;
}

/**
 * A run in flight, per host. None of it belongs in the store: an abort controller is
 * not state a selector can compare, and the progress ticks are kept out on purpose,
 * so a tick renders the one leaf that shows it instead of every reader of the slice.
 */
interface UpgradeRun {
	isCancelling: boolean;
	abortController: AbortController | null;
	abortPromise: Promise<void> | null;
	progress: UpgradeProgress | null;
	listeners: Set<(progress: UpgradeProgress) => void>;
}

const runs = new WeakMap<IndividualSimHost<any>, UpgradeRun>();

const runOf = (host: IndividualSimHost<any>): UpgradeRun => {
	let run = runs.get(host);
	if (!run) {
		run = { isCancelling: false, abortController: null, abortPromise: null, progress: null, listeners: new Set() };
		runs.set(host, run);
	}
	return run;
};

export const subscribeUpgradeProgress = (host: IndividualSimHost<any>, listener: (progress: UpgradeProgress) => void): (() => void) => {
	const { listeners } = runOf(host);
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};

const setSimulationProgress = (host: IndividualSimHost<any>, current: number, total: number, title: string) => {
	const progress: UpgradeProgress = { stage: 'sim', title, current: current - 1, total };
	const run = runOf(host);
	run.progress = progress;
	for (const listener of run.listeners) listener(progress);
};

const throwIfUpgradeAborted = (host: IndividualSimHost<any>, signal: AbortSignal) => {
	if (signal.aborted || runOf(host).isCancelling) {
		throw new Error('Upgrade Sim Aborted');
	}
};

const runWithUpgradeAbort = async <T>(host: IndividualSimHost<any>, promise: Promise<T>, signal: AbortSignal): Promise<T> => {
	throwIfUpgradeAborted(host, signal);

	let abortHandler: (() => void) | null = null;
	const abortPromise = new Promise<never>((_, reject) => {
		abortHandler = () => reject(new Error('Upgrade Sim Aborted'));
		signal.addEventListener('abort', abortHandler, { once: true });
	});

	try {
		return await Promise.race([promise, abortPromise]);
	} finally {
		if (abortHandler) {
			signal.removeEventListener('abort', abortHandler);
		}
	}
};

// A single-gear sim via the host, reduced to its raw distribution metrics. hist and
// allValues hold thousands of entries and are never displayed, so they are stripped
// here: the results they hang off of end up in localStorage.
const runSingleGearSim = async (host: IndividualSimHost<any>, gear: UpgradeGearResult['gear'], abortSignal: AbortSignal) => {
	const response = await runWithUpgradeAbort(
		host,
		host.runGearSim(gear, () => {}),
		abortSignal,
	);
	if (!response || 'type' in response) {
		throw new Error(response?.message);
	}
	const dpsMetrics = response[1].raidMetrics!.dps!;
	dpsMetrics.hist = [];
	dpsMetrics.allValues = [];
	return dpsMetrics;
};

/**
 * Substitutes a candidate into a base gear set: the slot's worn item is replaced, the
 * authored enchant and random suffix are carried over, and every unfrozen empty
 * socket gets its color's configured fallback gem. (The BiS-comparison variant passes
 * no fallback gems so an identity swap reproduces the reference set exactly.)
 */
export const buildUpgradeCandidateGear = (
	host: IndividualSimHost<any>,
	baseGear: UpgradeGearResult['gear'],
	candidate: UpgradeCandidate,
	slot: ItemSlot,
	useFallbackGems: boolean,
) => {
	const currentItem = baseGear.getEquippedItem(slot);
	let updatedItem = currentItem ? currentItem.withItem(candidate.equippedItem.item) : candidate.equippedItem;

	if (candidate.selectedEnchant) {
		updatedItem = updatedItem.withEnchant(candidate.selectedEnchant);
	}
	if (candidate.equippedItem.randomSuffix) {
		updatedItem = updatedItem.withRandomSuffix(candidate.equippedItem.randomSuffix);
	}

	let gear = baseGear.withEquippedItem(slot, updatedItem);
	if (useFallbackGems) {
		const frozenSockets = host.reforger ? frozenGemSocketSet(host.reforger.settings.toProto()) : undefined;
		gear = gear.fillSocketsWithGems(getDefaultGemsByColor(host.player), frozenSockets ? new Set(frozenSockets) : undefined);
	}
	return gear;
};

const abortUpgradeSimWork = async (host: IndividualSimHost<any>) => {
	const run = runOf(host);
	if (run.abortPromise) {
		return run.abortPromise;
	}

	const abortController = run.abortController;
	if (!abortController) return;

	run.abortController = null;
	if (!abortController.signal.aborted) {
		abortController.abort();
	}

	run.abortPromise = (async () => {
		// Upgrade sims register as IndividualSim (via runGearSim); the gem pre-pass
		// registers as ReforgeOptimize. Aborting more would cancel an unrelated run.
		const abortTasks: Promise<unknown>[] = [host.sim.signalManager.abortType(RequestTypes.IndividualSim | RequestTypes.ReforgeOptimize)];
		if (host.reforger) {
			abortTasks.push(host.reforger.abortReforgeOptimization());
		}
		await Promise.all(abortTasks);
	})();

	try {
		await run.abortPromise;
	} finally {
		run.abortPromise = null;
	}
};

export const cancelUpgradeSim = async (host: IndividualSimHost<any>) => {
	const run = runOf(host);
	if (!upgradeState(host.player).isRunning || run.isCancelling) return;

	run.isCancelling = true;
	await abortUpgradeSimWork(host);
};

export const runUpgradeSim = async (host: IndividualSimHost<any>) => {
	const { sim, player } = host;
	const run = runOf(host);
	const state = upgradeState(player);
	if (state.isRunning) return;

	const candidates = state.candidates;

	// Resolve the BiS reference up front so a deleted/renamed set doesn't distort the
	// progress total; warn and continue without the reference instead of failing.
	let bisGear: Gear | null = null;
	if (state.compareBisEnabled && state.bisReferenceName) {
		bisGear = resolveBisReferenceGear(host);
		if (!bisGear) {
			toastManager.add({
				delay: 4000,
				variant: 'warning',
				body: i18n.t('upgrade_tab.notifications.bis_set_missing', { name: state.bisReferenceName }),
			});
		}
	}

	// With a reference set, each candidate also gets simmed swapped onto that set —
	// unless the swap reproduces the reference gear exactly (the reference set already
	// wears that item), in which case the delta is 0 by definition and no sim is run.
	const isBisIdentitySwap = (candidate: UpgradeCandidate, slot: ItemSlot): boolean => {
		if (!bisGear) return true;
		const bisCandidateGear = buildUpgradeCandidateGear(host, bisGear, candidate, slot, false);
		return EquipmentSpec.equals(bisCandidateGear.asSpec(), bisGear.asSpec());
	};

	let candidateRuns = 0;
	candidates.forEach(candidate => {
		upgradeEligibleSlots(player, candidate).forEach(slot => {
			candidateRuns += 1 + (bisGear && !isBisIdentitySwap(candidate, slot) ? 1 : 0);
		});
	});
	const totalRuns = 1 + candidateRuns + (bisGear ? 1 : 0);
	if (totalRuns <= 1) return;

	trackEvent({
		action: 'sim',
		category: 'simulate',
		label: 'upgrade_finder',
		value: totalRuns - 1,
	});

	run.isCancelling = false;
	run.abortController = new AbortController();
	run.abortPromise = null;
	const abortSignal = run.abortController.signal;
	patchUpgradeState(player, { isRunning: true });

	await sim.waitForInit();
	let results: UpgradeGearResult | null = null;
	let bisResult: UpgradeGearResult | null = null;
	let upgradeResults: UpgradeResult[] = [];
	let runError: unknown = null;
	let originalGear = player.getGear();

	try {
		// The loop replaces any in-flight single sim or previous finder run.
		await sim.signalManager.abortType(RequestTypes.IndividualSim | RequestTypes.BulkSim);
		originalGear = player.getGear();
		patchUpgradeState(player, { runGear: originalGear });

		let currentRun = 1;
		setSimulationProgress(host, currentRun, totalRuns, i18n.t('upgrade_tab.progress.baseline'));
		const baselineDps = await runSingleGearSim(host, originalGear, abortSignal);
		results = { gear: originalGear, dpsMetrics: baselineDps };
		currentRun++;

		if (bisGear) {
			throwIfUpgradeAborted(host, abortSignal);
			setSimulationProgress(host, currentRun, totalRuns, i18n.t('upgrade_tab.progress.bis_reference'));
			const bisDpsMetrics = await runSingleGearSim(host, bisGear, abortSignal);
			bisResult = { gear: bisGear, dpsMetrics: bisDpsMetrics };
			currentRun++;
		}

		const candidateResults: UpgradeResult[] = [];

		for (const candidate of candidates) {
			let bestResult: UpgradeResult | null = null;

			for (const slot of upgradeEligibleSlots(player, candidate)) {
				throwIfUpgradeAborted(host, abortSignal);
				setSimulationProgress(host, currentRun, totalRuns, i18n.t('upgrade_tab.progress.item', { itemName: candidate.equippedItem.item.name }));

				let candidateGear = buildUpgradeCandidateGear(host, originalGear, candidate, slot, true);
				if (state.optimizeGems && host.reforger) {
					setSimulationProgress(
						host,
						currentRun,
						totalRuns,
						i18n.t('upgrade_tab.progress.optimize_gems', { itemName: candidate.equippedItem.item.name }),
					);
					candidateGear = await runWithUpgradeAbort(host, host.reforger.optimizeReforges(candidateGear), abortSignal);
				}
				const dpsMetrics = await runSingleGearSim(host, candidateGear, abortSignal);

				// The candidate's delta within the BiS reference set: the same item swap
				// applied to the reference gear, without the fallback gems (so an identity
				// swap reproduces the reference set exactly).
				let bisDelta: number | undefined = undefined;
				if (bisGear && bisResult) {
					if (isBisIdentitySwap(candidate, slot)) {
						bisDelta = 0;
					} else {
						let bisCandidateGear = buildUpgradeCandidateGear(host, bisGear, candidate, slot, false);
						if (state.optimizeGems && host.reforger) {
							bisCandidateGear = await runWithUpgradeAbort(host, host.reforger.optimizeReforges(bisCandidateGear), abortSignal);
						}
						setSimulationProgress(
							host,
							currentRun,
							totalRuns,
							i18n.t('upgrade_tab.progress.item_on_bis', { itemName: candidate.equippedItem.item.name }),
						);
						const bisMetrics = await runSingleGearSim(host, bisCandidateGear, abortSignal);
						bisDelta = bisMetrics.avg - bisResult.dpsMetrics.avg;
						currentRun++;
					}
				}

				const result: UpgradeResult = {
					item: candidate.equippedItem,
					slot,
					gear: candidateGear,
					dpsMetrics,
					delta: dpsMetrics.avg - baselineDps.avg,
					bisDelta,
				};

				if (!bestResult || result.delta > bestResult.delta) {
					bestResult = result;
				}
				currentRun++;
			}

			if (bestResult) {
				candidateResults.push(bestResult);
			}
		}

		candidateResults.sort((a, b) => b.delta - a.delta);
		upgradeResults = candidateResults;
	} catch (error) {
		runError = error;
		console.error(error);
		const errorMessage = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
		if (!run.isCancelling && errorMessage) {
			toastManager.add({ variant: 'error', body: errorMessage });
		}
	} finally {
		const wasCancelling = run.isCancelling;
		if (wasCancelling || runError) {
			await abortUpgradeSimWork(host);
		}
		await player.setGearAsync(upgradeState(player).runGear ?? originalGear);
		if (wasCancelling) {
			toastManager.add({
				variant: 'error',
				body: i18n.t('upgrade_tab.notifications.sim_cancelled'),
			});
		}
		run.isCancelling = false;
		run.progress = null;
		patchUpgradeState(player, results && !runError ? { isRunning: false, baseline: results, bisResult, results: upgradeResults } : { isRunning: false }, [
			'results',
		]);
		if (results && !runError) {
			storeUpgradeRunState(player);
		}
	}
};
