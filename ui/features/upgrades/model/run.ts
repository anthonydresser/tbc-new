// The upgrade finder's sim loop: one baseline sim of the worn gear, then one sim per
// candidate per slot it fits (the best slot wins the row). Gem optimization is the
// optional reforge pre-pass per candidate, like bulk's. With a BiS reference set
// selected, the loop also sims the reference set and swaps every candidate into it.
import { EquipmentSpec, type ItemSlot } from '@generated/proto/common';
import i18n from '@i18n/config';
import { cleanBulkDpsMetrics } from '@sim/bulk/utils';
import type { Gear } from '@sim/proto/gear';
import { frozenGemSocketSet } from '@sim/proto/items';
import { patchUpgradeState, storeUpgradeRunState, upgradeState } from '@sim/settings/upgrade_settings';
import type { IndividualSimHost } from '@sim/sim_host';
import { RequestTypes } from '@sim/sim_signal_manager';
import type { UpgradeCandidate, UpgradeGearResult, UpgradeResult } from '@sim/upgrade/types';
import { toastManager } from '@ui-kit/Toast';

import { trackEvent } from '../../../tracking/utils';
import { resolveBisReferenceGear } from './bis_reference';
import { bestComboResultForCandidate, planInventoryCombos } from './inventory_combos';
import { getDefaultGemsByColor, getUpgradeSimSlots, upgradeEligibleSlots } from './items';

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
 * authored enchant and random suffix are carried over, the candidate's authored gems
 * are placed into their sockets (clamped to the item's socket count), and every
 * remaining unfrozen empty socket gets its color's configured fallback gem. (The
 * BiS-comparison variant passes no fallback gems so an identity swap reproduces the
 * reference set exactly.)
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
	// withItem keeps the worn item's gems; candidates that author their own (inventory
	// imports) get theirs back socket-for-socket before the fallback fill runs.
	candidate.equippedItem.gems.forEach((gem, socketIdx) => {
		if (gem && socketIdx < updatedItem.numPossibleSockets) {
			updatedItem = updatedItem.withGem(gem, socketIdx);
		}
	});

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
		// registers as ReforgeOptimize; the inventory-combos mode runs its batch
		// through BulkSim. Aborting more would cancel an unrelated run.
		const abortTasks: Promise<unknown>[] = [
			host.sim.signalManager.abortType(RequestTypes.IndividualSim | RequestTypes.ReforgeOptimize | RequestTypes.BulkSim),
		];
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

	// Captured before counting: equipped-identity slots (the slot already wears the
	// item and no second copy could be worn) are not simmed and don't count.
	const originalGear = player.getGear();

	// With inventory combos on, each candidate's combo family runs as ONE bulk call,
	// so it counts as one run regardless of family size. The plan is a snapshot of the
	// inventory and gear at run start; a mid-run gear edit can only skew bulk's
	// internal baseline, never a displayed delta (those use the run's own baseline sim).
	const frozenSockets = host.reforger ? new Set(frozenGemSocketSet(host.reforger.settings.toProto())) : undefined;
	const comboPlan = state.includeInventoryCombos
		? planInventoryCombos(
				player,
				originalGear,
				candidates,
				(candidate, slot) => buildUpgradeCandidateGear(host, originalGear, candidate, slot, true),
				getDefaultGemsByColor(player),
				frozenSockets,
			)
		: null;
	if (comboPlan?.truncated) {
		toastManager.add({
			delay: 4000,
			variant: 'warning',
			body: i18n.t('upgrade_tab.notifications.combos_capped'),
		});
	}

	let candidateRuns = 0;
	candidates.forEach((candidate, candidateIndex) => {
		const simSlots = getUpgradeSimSlots(player, originalGear, candidate);
		const comboEntries = comboPlan?.byCandidate[candidateIndex] ?? [];
		if (comboEntries.length >= 1) {
			// The bulk call is one run; the BiS swap sims only the winning slot, which is
			// unknown up front, so count one unless every slot is an identity swap.
			candidateRuns += 1;
			if (bisGear && simSlots.some(slot => !isBisIdentitySwap(candidate, slot))) candidateRuns += 1;
			return;
		}
		simSlots.forEach(slot => {
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

	try {
		// The loop replaces any in-flight single sim or previous finder run.
		await sim.signalManager.abortType(RequestTypes.IndividualSim | RequestTypes.BulkSim);
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

		for (const [candidateIndex, candidate] of candidates.entries()) {
			// Inventory-combo mode: one bulk call covers the plain swap and every planned
			// inventory-swap combination of this candidate (topResults is capped and
			// staged culling drops losers, so each candidate gets its own call). The best
			// combo wins the row; its plan entry already carries the gear, the winning
			// slot and which other slots changed — nothing is re-derived from the result.
			const comboEntries = comboPlan?.byCandidate[candidateIndex] ?? [];
			// >= 1, not > 1: interchangeable pairs (rings/trinkets) can dedupe a family
			// down to a single entry, and that one must still go through the plan path —
			// falling through to the sequential per-slot path would sim both orientations.
			if (comboEntries.length >= 1) {
				throwIfUpgradeAborted(host, abortSignal);
				setSimulationProgress(host, currentRun, totalRuns, i18n.t('upgrade_tab.progress.combos', { itemName: candidate.equippedItem.item.name }));
				// Gem optimization applies iff the upgrade finder's own toggle is on
				// (the bulk gem pre-pass consumes the same reforge config).
				const reforgeConfig = state.optimizeGems && host.reforger ? host.reforger.getReforgeOptimizeConfig(originalGear) : undefined;
				// bulkSettings is deliberately omitted: on a native backend it would switch
				// candidate generation to the backend and discard our planned gear sets.
				const bulkResult = await runWithUpgradeAbort(
					host,
					sim.runBulkSim(
						comboEntries.map(entry => entry.gear),
						() => {},
						reforgeConfig,
						undefined,
						undefined,
						abortSignal,
					),
					abortSignal,
				);
				if (!bulkResult || 'type' in bulkResult) {
					throw new Error(bulkResult?.message);
				}
				const best = bestComboResultForCandidate(bulkResult.topResults, comboEntries);
				if (best) {
					// The simmed set is the backend's optimized gear when the gem pre-pass ran;
					// the plan entry's gear only carries authored+fallback gems. Enchants come
					// from the plan gear regardless: prepareGear stripped ring enchants for a
					// non-enchanter before the solve, and equipping the result must not wipe the
					// enchants authored on inventory (or baseline) items.
					let resultGear = best.entry.gear;
					if (reforgeConfig && best.optimizedSpec) {
						let optimizedGear = sim.db.lookupEquipmentSpec(best.optimizedSpec);
						for (const slot of best.entry.gear.getItemSlots()) {
							const planned = best.entry.gear.getEquippedItem(slot);
							const optimizedItem = optimizedGear.getEquippedItem(slot);
							if (!planned || !optimizedItem) continue;
							if ((planned._enchant?.effectId ?? 0) !== (optimizedItem._enchant?.effectId ?? 0)) {
								optimizedGear = optimizedGear.withEquippedItem(slot, optimizedItem.withEnchant(planned.enchant));
							}
						}
						resultGear = optimizedGear;
					}
					// BiS comparison stays single-swap (no combos on the reference set), on
					// the winning slot. A pre-count sim slot that turns out identity here
					// merely leaves the progress total one short.
					let bisDelta: number | undefined = undefined;
					const slot = best.entry.slot;
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
								currentRun + 1,
								totalRuns,
								i18n.t('upgrade_tab.progress.item_on_bis', { itemName: candidate.equippedItem.item.name }),
							);
							const bisMetrics = await runSingleGearSim(host, bisCandidateGear, abortSignal);
							bisDelta = bisMetrics.avg - bisResult.dpsMetrics.avg;
							currentRun++;
						}
					}
					candidateResults.push({
						item: candidate.equippedItem,
						slot,
						gear: resultGear,
						dpsMetrics: cleanBulkDpsMetrics(best.dpsMetrics),
						delta: best.dpsMetrics.avg - baselineDps.avg,
						bisDelta,
						swappedSlots: best.entry.swappedSlots.length ? best.entry.swappedSlots : undefined,
					});
				}
				currentRun++;
				continue;
			}

			let bestResult: UpgradeResult | null = null;

			const eligibleSlots = upgradeEligibleSlots(player, candidate);
			const simSlots = getUpgradeSimSlots(player, originalGear, candidate);
			if (eligibleSlots.length && !simSlots.length) {
				// Every slot the item fits already wears it (or its only slot does), so
				// any swap is the identity and its delta is 0 by definition: skip the
				// sims and record a marker row instead. No bisDelta — that comparison
				// was not simmed either.
				candidateResults.push({
					item: candidate.equippedItem,
					slot: eligibleSlots[0],
					gear: originalGear,
					dpsMetrics: baselineDps,
					delta: 0,
					equippedAlready: true,
				});
				continue;
			}

			for (const slot of simSlots) {
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
