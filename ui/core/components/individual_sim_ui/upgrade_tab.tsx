import { Tab } from 'bootstrap';
import clsx from 'clsx';
import { ref } from 'tsx-vanilla';

import i18n from '../../../i18n/config';
import { BaseModal } from '../base_modal';
import { IndividualSimUI } from '../../individual_sim_ui';
import { DistributionMetrics, ProgressMetrics, RaidSimResult } from '../../proto/api';
import { EquipmentSpec, GemColor, ItemSlot, ItemSpec } from '../../proto/common';
import { SimGem } from '../../proto/db';
import { RepFaction, UIEnchant, UIGem, UIItem, UIItem_FactionRestriction } from '../../proto/ui';
import { ActionId } from '../../proto_utils/action_id';
import { EquippedItem } from '../../proto_utils/equipped_item';
import { Gear } from '../../proto_utils/gear';
import { getEmptyGemSocketIconUrl } from '../../proto_utils/gems';
import { difficultyNames, professionNames, REP_FACTION_NAMES, REP_FACTION_QUARTERMASTERS, REP_LEVEL_NAMES } from '../../proto_utils/names';
import { canEquipItem, enchantAppliesToItem, getEligibleItemSlots, getPVPSeasonFromItem, isPVPItem } from '../../proto_utils/utils';
import { RequestTypes } from '../../sim_signal_manager';
import { TypedEvent } from '../../typed_event';
import { formatDeltaTextElem, formatToNumber } from '../../utils';
import { ItemRenderer } from '../gear_picker/gear_picker';
import SelectorModal, { SelectorModalTabs } from '../gear_picker/selector_modal';
import { GearData } from '../gear_picker/item_list';
import { ProgressTrackerModal } from '../progress_tracker_modal';
import { BooleanPicker } from '../pickers/boolean_picker';
import { SavedDataManager } from '../saved_data_manager';
import { SimTab } from '../sim_tab';
import Toast from '../toast';
import BulkItemSearch from './bulk/bulk_item_search';
import GemSelectorModal from './bulk/gem_selector_modal';
import { BulkItemSearchHost } from './bulk/utils';
import { TopGearResult } from './bulk_tab';
import { trackEvent } from '../../../tracking/utils';
import { translateSlotName } from '../../../i18n/localization';
import { BisListJsonImporter, BisListImportResult } from './importers/bis_list_json_importer';
import { parseBisListJson } from '../../proto_utils/bis_list_parser';
import { BisListPresetEntry, getBisListPresetManifest, getPresetsForSpec, loadBisListPreset } from '../../proto_utils/bis_list_presets';

export interface UpgradeResult {
	item: EquippedItem;
	slot: ItemSlot;
	gear: Gear;
	dpsMetrics: DistributionMetrics;
	delta: number;
}

interface SavedUpgradeRun {
	name: string;
	timestamp: number;
	items: any[];
	fallbackGems: number[];
	optimizeGems: boolean;
	baselineResult: any;
	upgradeResults: any[];
}

interface CandidateItem {
	spec: ItemSpec;
	equippedItem: EquippedItem;
	selectedEnchant: UIEnchant | null;
}

export class UpgradeTab extends SimTab implements BulkItemSearchHost {
	readonly simUI: IndividualSimUI<any>;

	private readonly setupTabElem: HTMLElement;
	private readonly resultsTabElem: HTMLElement;
	private readonly runButton: HTMLButtonElement;
	private readonly settingsContainer: HTMLElement;
	private readonly combinationsElem: HTMLElement;
	private readonly candidateListElem: HTMLElement;
	private readonly resultsTableElem: HTMLElement;
	private readonly resultsTab: Tab;
	private readonly progressTrackerModal: ProgressTrackerModal;
	private readonly selectorModal: SelectorModal;
	private readonly bisListImporter: BisListJsonImporter;

	private candidateItems: CandidateItem[] = [];
	private fallbackGems: SimGem[];
	private gemIconElements: HTMLImageElement[] = [];
	private optimizeGems = false;
	private readonly optimizeGemsChangeEmitter = new TypedEvent<void>();

	private isRunning = false;
	private isCancelling = false;
	private abortController: AbortController | null = null;

	private baselineResult: TopGearResult | null = null;
	private upgradeResults: UpgradeResult[] = [];

	constructor(parentElem: HTMLElement, simUI: IndividualSimUI<any>) {
		super(parentElem, simUI, { identifier: 'upgrade-tab', title: i18n.t('upgrade_tab.title') });

		this.simUI = simUI;

		const setupTabBtnRef = ref<HTMLButtonElement>();
		const setupTabRef = ref<HTMLDivElement>();
		const resultsTabBtnRef = ref<HTMLButtonElement>();
		const resultsTabRef = ref<HTMLDivElement>();
		const settingsContainerRef = ref<HTMLDivElement>();
		const combinationsElemRef = ref<HTMLDivElement>();
		const runBtnRef = ref<HTMLButtonElement>();
		const importFavsBtnRef = ref<HTMLButtonElement>();
		const copyEnchantsBtnRef = ref<HTMLButtonElement>();
		const importBisBtnRef = ref<HTMLButtonElement>();
		const loadPresetPhaseRef = ref<HTMLSelectElement>();
		const loadPresetBtnRef = ref<HTMLButtonElement>();
		const clearBtnRef = ref<HTMLButtonElement>();
		const candidateListRef = ref<HTMLDivElement>();
		const searchContainerRef = ref<HTMLDivElement>();
		const resultsTableRef = ref<HTMLTableElement>();
		const savedRunsContainerRef = ref<HTMLDivElement>();

		this.contentContainer.appendChild(
			<>
				<div className="upgrade-tab-left tab-panel-left">
					<div className="upgrade-tab-tabs">
						<ul className="nav nav-tabs" attributes={{ role: 'tablist' }}>
							<li className="nav-item" attributes={{ role: 'presentation' }}>
								<button
									className="nav-link active"
									type="button"
									attributes={{
										role: 'tab',
										// @ts-expect-error
										'aria-controls': 'upgradeSetupTab',
										'aria-selected': true,
									}}
									dataset={{
										bsToggle: 'tab',
										bsTarget: `#upgradeSetupTab`,
									}}
									ref={setupTabBtnRef}>
									{i18n.t('upgrade_tab.tabs.setup')}
								</button>
							</li>
							<li className="nav-item" attributes={{ role: 'presentation' }}>
								<button
									className="nav-link"
									type="button"
									attributes={{
										role: 'tab',
										// @ts-expect-error
										'aria-controls': 'upgradeResultsTab',
										'aria-selected': false,
									}}
									dataset={{
										bsToggle: 'tab',
										bsTarget: `#upgradeResultsTab`,
									}}
									ref={resultsTabBtnRef}>
									{i18n.t('upgrade_tab.tabs.results')}
								</button>
							</li>
						</ul>
						<div className="tab-content">
							<div id="upgradeSetupTab" className="tab-pane fade active show" ref={setupTabRef}>
								<p className="mb-0" innerHTML={i18n.t('upgrade_tab.description')} />
								<div className="upgrade-gear-actions">
									<button className="btn btn-secondary" ref={importFavsBtnRef}>
										<i className="fa fa-download me-1" /> {i18n.t('upgrade_tab.actions.import_favorites')}
									</button>
									<button className="btn btn-secondary" ref={copyEnchantsBtnRef}>
										<i className="fa fa-magic me-1" /> {i18n.t('upgrade_tab.actions.copy_enchants')}
									</button>
									<button className="btn btn-secondary" ref={importBisBtnRef}>
										<i className="fa fa-list me-1" /> {i18n.t('upgrade_tab.actions.import_bis_list')}
									</button>
									<div className="preset-controls input-group input-group-sm w-auto ms-2">
										<span className="input-group-text">{i18n.t('upgrade_tab.presets.label')}</span>
										<select className="form-select" ref={loadPresetPhaseRef} disabled>
											<option value="">{i18n.t('upgrade_tab.presets.select_phase')}</option>
										</select>
										<button className="btn btn-secondary" ref={loadPresetBtnRef} disabled>
											<i className="fa fa-cloud-download-alt me-1" /> {i18n.t('upgrade_tab.presets.load')}
										</button>
									</div>
									<button className="btn btn-danger ms-auto" ref={clearBtnRef}>
										<i className="fas fa-times me-1" />
										{i18n.t('upgrade_tab.actions.clear_items')}
									</button>
								</div>
								<div className="upgrade-search-container" ref={searchContainerRef} />
								<div className="upgrade-candidate-list" ref={candidateListRef} />
							</div>
							<div id="upgradeResultsTab" className="tab-pane fade show" ref={resultsTabRef}>
								<div className="upgrade-results-placeholder">{i18n.t('upgrade_tab.results.run_simulation')}</div>
								<table className="table upgrade-results-table hide" ref={resultsTableRef}>
									<thead>
										<tr>
											<th>{i18n.t('upgrade_tab.results.rank')}</th>
											<th>{i18n.t('upgrade_tab.results.item')}</th>
											<th>{i18n.t('upgrade_tab.results.slot')}</th>
											<th>{i18n.t('upgrade_tab.results.dps')}</th>
											<th>{i18n.t('upgrade_tab.results.delta')}</th>
											<th>{i18n.t('upgrade_tab.results.source')}</th>
											<th>{i18n.t('upgrade_tab.results.action')}</th>
										</tr>
									</thead>
									<tbody />
								</table>
							</div>
						</div>
					</div>
				</div>
				<div className="upgrade-tab-right tab-panel-right">
					<div className="upgrade-settings-outer-container">
						<div className="upgrade-settings-container" ref={settingsContainerRef}>
							<div className="upgrade-combinations-count h4" ref={combinationsElemRef} />
							<button className="btn btn-primary upgrade-settings-btn" ref={runBtnRef}>
								{i18n.t('upgrade_tab.actions.simulate')}
							</button>
							<div className="fallback-gem-container">
								<h6>{i18n.t('upgrade_tab.settings.fallback_gems')}</h6>
								<div className="sockets-container" ref={ref<HTMLDivElement>()} />
							</div>
							<div className="upgrade-optimize-gems" ref={ref<HTMLDivElement>()} />
							<div className="upgrade-saved-runs" ref={savedRunsContainerRef} />
						</div>
					</div>
				</div>
			</>,
		);

		this.setupTabElem = setupTabRef.value!;
		this.resultsTabElem = resultsTabRef.value!;
		this.settingsContainer = settingsContainerRef.value!;
		this.combinationsElem = combinationsElemRef.value!;
		this.runButton = runBtnRef.value!;
		this.candidateListElem = candidateListRef.value!;
		this.resultsTableElem = resultsTableRef.value!;

		importFavsBtnRef.value!.addEventListener('click', () => this.importFavorites());
		copyEnchantsBtnRef.value!.addEventListener('click', () => this.copyEquippedEnchantsToCandidates());
		clearBtnRef.value!.addEventListener('click', () => this.clearItems());
		new BulkItemSearch(searchContainerRef.value!, this.simUI, this);

		new Tab(setupTabBtnRef.value!);
		this.resultsTab = new Tab(resultsTabBtnRef.value!);

		this.progressTrackerModal = new ProgressTrackerModal(simUI.rootElem, {
			id: 'upgrade-sim-progress-tracker',
			title: 'Upgrade Finder',
			hasProgressBar: true,
			onCancel: () => this.abortUpgradeSim(),
		});
		this.selectorModal = new SelectorModal(this.simUI.rootElem, this.simUI, this.simUI.player, undefined, {
			id: 'upgrade-selector-modal',
		});

		this.bisListImporter = new BisListJsonImporter(this.simUI.rootElem, this.simUI, {
			onImport: result => this.importBisList(result),
		});
		importBisBtnRef.value!.addEventListener('click', () => this.bisListImporter.open());
		this.initPresetControls(loadPresetPhaseRef.value!, loadPresetBtnRef.value!);

		this.fallbackGems = Array.from({ length: 5 }, () => UIGem.create());

		this.runButton.addEventListener('click', () => this.runUpgradeSim());

		this.simUI.sim.waitForInit().then(() => {
			this.loadSettings();
			this.renderCandidateList();
			this.updateCombinationsCount();
			this.buildGemPicker();
			this.buildOptimizeGemsToggle();
			this.buildSavedRunsManager(savedRunsContainerRef.value!);
			if (this.upgradeResults.length > 0 && this.baselineResult) {
				this.renderResults();
			}
		});
	}

	protected buildTabContent(): void {
		// Tab content is constructed in the constructor.
	}

	private getSettingsKey(): string {
		return this.simUI.getStorageKey('upgrade-settings.v1');
	}

	private getSavedRunsStorageKey(): string {
		return this.simUI.getStorageKey('__savedUpgradeRuns__');
	}

	private serializeRunState(name?: string): SavedUpgradeRun {
		return {
			name: name ?? '',
			timestamp: Date.now(),
			items: this.candidateItems.map(candidate => {
				const base = ItemSpec.toJson(candidate.spec) as Record<string, any>;
				base.enchant = candidate.selectedEnchant?.effectId;
				return base;
			}),
			fallbackGems: this.fallbackGems.map(gem => gem.id),
			optimizeGems: this.optimizeGems,
			baselineResult: this.baselineResult
				? {
						gear: EquipmentSpec.toJson(this.baselineResult.gear.asSpec()),
						dpsMetrics: DistributionMetrics.toJson(this.baselineResult.dpsMetrics),
					}
				: null,
			upgradeResults: this.upgradeResults.map(result => ({
				item: ItemSpec.toJson(result.item.asSpec()),
				slot: result.slot,
				gear: EquipmentSpec.toJson(result.gear.asSpec()),
				dpsMetrics: DistributionMetrics.toJson(result.dpsMetrics),
				delta: result.delta,
			})),
		};
	}

	private applyRunState(run: SavedUpgradeRun) {
		this.candidateItems = [];
		(run.items || []).forEach(itemJson => {
			try {
				const itemSpec = ItemSpec.fromJson(itemJson);
				const equippedItem = this.simUI.sim.db.lookupItemSpec(itemSpec)?.withDynamicStats();
				if (!equippedItem) return;
				const enchant = itemJson.enchant ? this.findEnchantForItem(itemSpec.id, itemJson.enchant) : null;
				this.candidateItems.push({ spec: itemSpec, equippedItem, selectedEnchant: enchant ?? null });
			} catch {
				// Ignore malformed saved items.
			}
		});

		this.fallbackGems = Array.from({ length: 5 }, () => UIGem.create());
		(run.fallbackGems || []).forEach((id, idx) => {
			if (idx < this.fallbackGems.length) {
				this.fallbackGems[idx] = SimGem.create({ id });
			}
		});

		this.optimizeGems = run.optimizeGems ?? false;
		this.optimizeGemsChangeEmitter.emit(TypedEvent.nextEventID());

		this.baselineResult = this.parseStoredTopGearResult(run.baselineResult);
		this.upgradeResults = (run.upgradeResults || [])
			.map(resultJson => this.parseStoredUpgradeResult(resultJson))
			.filter((result): result is UpgradeResult => result != null);
	}

	private parseStoredTopGearResult(resultJson: any): TopGearResult | null {
		if (!resultJson) return null;
		try {
			const equipmentSpec = EquipmentSpec.fromJson(resultJson.gear);
			const gear = this.simUI.sim.db.lookupEquipmentSpec(equipmentSpec);
			const dpsMetrics = DistributionMetrics.fromJson(resultJson.dpsMetrics);
			return { gear, dpsMetrics };
		} catch {
			return null;
		}
	}

	private parseStoredUpgradeResult(resultJson: any): UpgradeResult | null {
		if (!resultJson) return null;
		try {
			const itemSpec = ItemSpec.fromJson(resultJson.item);
			const item = this.simUI.sim.db.lookupItemSpec(itemSpec)?.withDynamicStats();
			if (!item) return null;

			const equipmentSpec = EquipmentSpec.fromJson(resultJson.gear);
			const gear = this.simUI.sim.db.lookupEquipmentSpec(equipmentSpec);
			const dpsMetrics = DistributionMetrics.fromJson(resultJson.dpsMetrics);
			return {
				item,
				slot: resultJson.slot,
				gear,
				dpsMetrics,
				delta: dpsMetrics.avg - (this.baselineResult?.dpsMetrics.avg ?? 0),
			};
		} catch {
			return null;
		}
	}

	private storeSettings() {
		try {
			window.localStorage.setItem(this.getSettingsKey(), JSON.stringify(this.serializeRunState()));
		} catch (e) {
			if (e && e instanceof DOMException && e.name === 'QuotaExceededError') {
				window.localStorage.removeItem(this.getSettingsKey());
			}
		}
	}

	private loadSettings() {
		const storedSettings = window.localStorage.getItem(this.getSettingsKey());
		if (storedSettings != null) {
			let parsed: SavedUpgradeRun;
			try {
				parsed = JSON.parse(storedSettings);
			} catch {
				parsed = this.serializeRunState();
			}
			this.applyRunState(parsed);
		}
	}

	private runToJson(run: SavedUpgradeRun): any {
		return JSON.parse(JSON.stringify(run));
	}

	private runFromJson(obj: any): SavedUpgradeRun {
		if (!obj || !Array.isArray(obj.items)) {
			throw new Error('Invalid saved upgrade run data');
		}
		return {
			name: obj.name ?? '',
			timestamp: obj.timestamp ?? 0,
			items: obj.items,
			fallbackGems: obj.fallbackGems ?? [],
			optimizeGems: obj.optimizeGems ?? false,
			baselineResult: obj.baselineResult ?? null,
			upgradeResults: obj.upgradeResults ?? [],
		};
	}

	private runsEqual(a: SavedUpgradeRun, b: SavedUpgradeRun): boolean {
		const normalize = (run: SavedUpgradeRun) => {
			const { name, timestamp, ...rest } = run;
			return JSON.stringify(rest);
		};
		return normalize(a) === normalize(b);
	}

	private buildSavedRunsManager(parent: HTMLElement) {
		const savedRunsManager = new SavedDataManager<UpgradeTab, SavedUpgradeRun>(parent, this, {
			header: { title: i18n.t('upgrade_tab.saved_runs.title') },
			label: i18n.t('upgrade_tab.saved_runs.run'),
			nameLabel: i18n.t('upgrade_tab.saved_runs.name'),
			saveButtonText: i18n.t('upgrade_tab.saved_runs.save'),
			storageKey: this.getSavedRunsStorageKey(),
			changeEmitters: [],
			getData: () => this.serializeRunState(),
			setData: (_eventID, _upgradeTab, data) => this.loadSavedRun(data),
			equals: (a, b) => this.runsEqual(a, b),
			toJson: run => this.runToJson(run),
			fromJson: obj => this.runFromJson(obj),
		});
		savedRunsManager.loadUserData();
	}

	private loadSavedRun(run: SavedUpgradeRun) {
		this.applyRunState(run);
		this.renderCandidateList();
		this.updateCombinationsCount();
		this.updateGemPickerIcons();
		this.renderResults();
		this.storeSettings();
		if (this.upgradeResults.length > 0 && this.baselineResult) {
			this.resultsTab.show();
		}
		new Toast({
			delay: 2000,
			variant: 'success',
			body: i18n.t('upgrade_tab.saved_runs.loaded', { name: run.name }),
		});
	}

	addItem(itemSpec: ItemSpec, silent = false) {
		if (this.candidateItems.some(candidate => ItemSpec.equals(candidate.spec, itemSpec))) {
			if (!silent) {
				new Toast({
					variant: 'error',
					body: i18n.t('upgrade_tab.notifications.item_duplicate'),
				});
			}
			return;
		}

		const equippedItem = this.simUI.sim.db.lookupItemSpec(itemSpec)?.withDynamicStats();
		if (!equippedItem) {
			if (!silent) {
				new Toast({
					variant: 'error',
					body: i18n.t('upgrade_tab.notifications.item_not_found'),
				});
			}
			return;
		}

		const eligibleSlots = getEligibleItemSlots(equippedItem.item).filter(slot => canEquipItem(equippedItem.item, this.simUI.player.getPlayerSpec(), slot));
		if (eligibleSlots.length === 0) {
			if (!silent) {
				new Toast({
					variant: 'error',
					body: i18n.t('upgrade_tab.notifications.item_not_equippable'),
				});
			}
			return;
		}

		this.candidateItems.push({ spec: ItemSpec.clone(itemSpec), equippedItem, selectedEnchant: null });
		this.renderCandidateList();
		this.updateCombinationsCount();
		this.storeSettings();

		if (!silent) {
			new Toast({
				delay: 1000,
				variant: 'success',
				body: <>{i18n.t('upgrade_tab.search.item_added', { itemName: equippedItem.item.name })}</>,
			});
		}
	}

	removeItem(index: number) {
		if (index < 0 || index >= this.candidateItems.length) return;
		const removed = this.candidateItems.splice(index, 1)[0];
		this.renderCandidateList();
		this.updateCombinationsCount();
		this.storeSettings();
		new Toast({
			delay: 1000,
			variant: 'success',
			body: <>{i18n.t('upgrade_tab.search.item_removed', { itemName: removed.equippedItem.item.name })}</>,
		});
	}

	clearItems() {
		this.candidateItems = [];
		this.renderCandidateList();
		this.updateCombinationsCount();
		this.storeSettings();
	}

	private importFavorites() {
		const filters = this.simUI.player.sim.getFilters();
		const items = filters.favoriteItems.map(itemID => ItemSpec.create({ id: itemID }));
		items.forEach(item => this.addItem(item, true));
		this.renderCandidateList();
		this.updateCombinationsCount();
		this.storeSettings();
	}

	private copyEquippedEnchantsToCandidates() {
		const currentGear = this.simUI.player.getGear();
		let applied = 0;
		let skipped = 0;

		for (const candidate of this.candidateItems) {
			const eligibleSlots = this.getEligibleSlots(candidate);
			let copiedEnchant: UIEnchant | null = null;

			for (const slot of eligibleSlots) {
				const equippedItem = currentGear.getEquippedItem(slot);
				if (!equippedItem?.enchant) continue;
				if (enchantAppliesToItem(equippedItem.enchant, candidate.equippedItem.item)) {
					copiedEnchant = equippedItem.enchant;
					break;
				}
			}

			if (copiedEnchant) {
				if (candidate.selectedEnchant?.effectId === copiedEnchant.effectId) {
					skipped++;
				} else {
					candidate.selectedEnchant = copiedEnchant;
					candidate.equippedItem = candidate.equippedItem.withEnchant(copiedEnchant);
					applied++;
				}
			}
		}

		this.renderCandidateList();
		this.storeSettings();

		if (applied > 0 || skipped > 0) {
			new Toast({
				delay: 2000,
				variant: skipped > 0 && applied === 0 ? 'warning' : 'success',
				body: <>{i18n.t('upgrade_tab.notifications.enchants_copied', { applied, skipped })}</>,
			});
		} else {
			new Toast({
				variant: 'warning',
				body: i18n.t('upgrade_tab.notifications.enchants_no_match'),
			});
		}
	}

	private importBisList(result: BisListImportResult) {
		let added = 0;
		let skipped = 0;
		for (const itemSpec of result.itemSpecs) {
			if (this.candidateItems.some(candidate => ItemSpec.equals(candidate.spec, itemSpec))) {
				skipped++;
				continue;
			}
			const countBefore = this.candidateItems.length;
			this.addItem(itemSpec, true);
			if (this.candidateItems.length > countBefore) {
				added++;
			} else {
				skipped++;
			}
		}

		this.renderCandidateList();
		this.updateCombinationsCount();
		this.storeSettings();

		if (added > 0 || skipped > 0) {
			new Toast({
				delay: 2000,
				variant: skipped > 0 ? 'warning' : 'success',
				body: (
					<>
						{skipped > 0
							? i18n.t('upgrade_tab.import_bis_list.imported_with_skipped', { added, skipped })
							: i18n.t('upgrade_tab.import_bis_list.imported', { count: added })}
					</>
				),
			});
		}
	}

	private async initPresetControls(phaseSelect: HTMLSelectElement, loadButton: HTMLButtonElement) {
		try {
			const manifest = await getBisListPresetManifest();
			const presets = getPresetsForSpec(manifest, this.simUI.player.getSpec());
			if (presets.length === 0) {
				return;
			}
			presets.forEach(preset => {
				const option = document.createElement('option');
				option.value = preset.path;
				option.textContent = i18n.t('upgrade_tab.presets.phase_option', { phase: preset.phase });
				phaseSelect.appendChild(option);
			});
			phaseSelect.disabled = false;
			loadButton.disabled = false;
			loadButton.addEventListener('click', () => {
				const selectedPath = phaseSelect.value;
				if (!selectedPath) return;
				const preset = presets.find(p => p.path === selectedPath);
				if (preset) {
					this.loadPreset(preset);
				}
			});
		} catch (error) {
			console.error('Failed to load BiS list presets:', error);
		}
	}

	private async loadPreset(preset: BisListPresetEntry) {
		try {
			const data = await loadBisListPreset(preset);
			const result = await parseBisListJson(data);
			if (result.itemSpecs.length === 0 && result.errors.length > 0) {
				new Toast({
					variant: 'error',
					body: <>{i18n.t('upgrade_tab.presets.load_failed', { label: preset.label })}</>,
				});
				return;
			}
			this.importBisList({ itemSpecs: result.itemSpecs });
			if (result.errors.length > 0) {
				const summary = result.errors
					.slice(0, 5)
					.map(e => e.message)
					.join('\n');
				new Toast({
					variant: 'warning',
					body: <>{i18n.t('upgrade_tab.presets.loaded_with_warnings', { label: preset.label, count: result.errors.length, errors: summary })}</>,
				});
			}
		} catch (error) {
			new Toast({
				variant: 'error',
				body: <>{i18n.t('upgrade_tab.presets.load_failed', { label: preset.label })}</>,
			});
			console.error('Failed to load preset:', error);
		}
	}

	private openEnchantSelector(candidateIndex: number) {
		const candidate = this.candidateItems[candidateIndex];
		const slot = this.getEligibleSlots(candidate)[0];

		const gearData: GearData = {
			getEquippedItem: () => {
				return candidate.equippedItem.withEnchant(candidate.selectedEnchant);
			},
			changeEvent: new TypedEvent<void>(),
			equipItem: (_eventID: any, equippedItem: EquippedItem | null) => {
				if (equippedItem) {
					candidate.selectedEnchant = equippedItem.enchant;
					candidate.equippedItem = equippedItem.withItem(candidate.equippedItem.item);
					this.renderCandidateList();
					this.storeSettings();
				}
			},
		};

		this.selectorModal.openTab(slot, SelectorModalTabs.Enchants, gearData);
	}

	private findEnchantForItem(itemId: number, effectId: number): UIEnchant | null {
		const item = this.simUI.sim.db.lookupItemSpec(ItemSpec.create({ id: itemId }))?.item;
		if (!item) return null;
		const slots = getEligibleItemSlots(item);
		for (const slot of slots) {
			const enchant = this.simUI.sim.db.getEnchants(slot).find(e => e.effectId === effectId || e.itemId === effectId || e.spellId === effectId);
			if (enchant) return enchant;
		}
		return null;
	}

	private getEligibleSlots(candidate: CandidateItem): ItemSlot[] {
		return getEligibleItemSlots(candidate.equippedItem.item).filter(slot =>
			canEquipItem(candidate.equippedItem.item, this.simUI.player.getPlayerSpec(), slot),
		);
	}

	private getTotalSimCount(): number {
		// Baseline + one sim per candidate per eligible slot.
		return 1 + this.candidateItems.reduce((sum, candidate) => sum + this.getEligibleSlots(candidate).length, 0);
	}

	private updateCombinationsCount() {
		const total = this.getTotalSimCount();
		const iterations = this.simUI.sim.getIterations() * (total - 1);
		this.runButton.disabled = total <= 1 || !this.simUI.sim.getIterations();
		this.combinationsElem.replaceChildren(
			<span>
				{total - 1 === 1 ? i18n.t('upgrade_tab.settings.sim_count_singular') : i18n.t('upgrade_tab.settings.sim_count', { count: total - 1 })}
				<br />
				<small>
					{iterations} {i18n.t('upgrade_tab.settings.iterations')}
				</small>
			</span>,
		);
	}

	private renderCandidateList() {
		this.candidateListElem.replaceChildren();
		if (this.candidateItems.length === 0) {
			this.candidateListElem.appendChild(<div className="upgrade-no-items">{i18n.t('upgrade_tab.picker.no_items')}</div>);
			return;
		}

		this.candidateItems.forEach((candidate, index) => {
			const rowRef = ref<HTMLDivElement>();
			const removeBtnRef = ref<HTMLButtonElement>();
			const enchantBtnRef = ref<HTMLButtonElement>();
			const slots = this.getEligibleSlots(candidate);
			const slotsLabel = slots.map(slot => translateSlotName(slot)).join(', ');

			this.candidateListElem.appendChild(
				<div className="upgrade-candidate-row" ref={rowRef}>
					<div className="upgrade-candidate-item" ref={ref<HTMLDivElement>()} />
					<div className="upgrade-candidate-meta">
						<div className="upgrade-candidate-slots">
							<small>{slotsLabel}</small>
						</div>
						<button className="btn btn-sm btn-outline-secondary upgrade-candidate-enchant-btn" ref={enchantBtnRef}>
							<i className="fas fa-magic me-1" />{' '}
							{candidate.selectedEnchant ? candidate.selectedEnchant.name : i18n.t('upgrade_tab.picker.add_enchant')}
						</button>
					</div>
					<button className="btn btn-link link-danger" ref={removeBtnRef}>
						<i className="fas fa-times" />
					</button>
				</div>,
			);

			const itemContainer = rowRef.value!.querySelector('.upgrade-candidate-item') as HTMLElement;
			const renderer = new ItemRenderer(rowRef.value!, itemContainer, this.simUI.player);
			renderer.update(candidate.selectedEnchant ? candidate.equippedItem.withEnchant(candidate.selectedEnchant) : candidate.equippedItem);

			enchantBtnRef.value!.addEventListener('click', () => this.openEnchantSelector(index));
			removeBtnRef.value!.addEventListener('click', () => this.removeItem(index));
		});
	}

	private buildGemPicker() {
		const socketsContainer = this.settingsContainer.querySelector('.fallback-gem-container .sockets-container') as HTMLElement;
		this.gemIconElements = [];

		Array<GemColor>(GemColor.GemColorRed, GemColor.GemColorYellow, GemColor.GemColorBlue, GemColor.GemColorMeta, GemColor.GemColorPrismatic).forEach(
			(socketColor, socketIndex) => {
				const gemContainerRef = ref<HTMLDivElement>();
				const gemIconRef = ref<HTMLImageElement>();
				const socketIconRef = ref<HTMLImageElement>();

				socketsContainer.appendChild(
					<div ref={gemContainerRef} className="gem-socket-container">
						<img ref={gemIconRef} className={clsx('gem-icon', !this.fallbackGems[socketIndex].id && 'hide')} />
						<img ref={socketIconRef} className="socket-icon" />
					</div>,
				);

				this.gemIconElements.push(gemIconRef.value!);
				socketIconRef.value!.src = getEmptyGemSocketIconUrl(socketColor);

				let selector: GemSelectorModal;

				const onSelectHandler = (itemData: any) => {
					this.fallbackGems[socketIndex] = SimGem.fromJson(UIGem.toJson(itemData.item), { ignoreUnknownFields: true });
					this.storeSettings();
					ActionId.fromItemId(itemData.id)
						.fill()
						.then(filledId => {
							gemIconRef.value!.src = filledId.iconUrl;
							gemIconRef.value!.classList.remove('hide');
						});
					selector.close();
				};

				const onRemoveHandler = () => {
					this.fallbackGems[socketIndex] = UIGem.create();
					this.storeSettings();
					gemIconRef.value!.classList.add('hide');
					gemIconRef.value!.src = '';
					selector.close();
				};

				const openGemSelector = () => {
					if (!selector) selector = new GemSelectorModal(this.simUI.rootElem, this.simUI, socketColor, onSelectHandler, onRemoveHandler);
					selector.show();
				};

				gemIconRef.value!.addEventListener('click', openGemSelector);
				gemContainerRef.value?.addEventListener('click', openGemSelector);
			},
		);

		this.updateGemPickerIcons();
	}

	private updateGemPickerIcons() {
		this.fallbackGems.forEach((gem, idx) => {
			const icon = this.gemIconElements[idx];
			if (!icon) return;
			if (gem.id) {
				ActionId.fromItemId(gem.id)
					.fill()
					.then(filledId => {
						icon.src = filledId.iconUrl;
						icon.classList.remove('hide');
					});
			} else {
				icon.src = '';
				icon.classList.add('hide');
			}
		});
	}

	private buildOptimizeGemsToggle() {
		const container = this.settingsContainer.querySelector('.upgrade-optimize-gems') as HTMLElement;
		new BooleanPicker<UpgradeTab>(container, this, {
			id: 'upgrade-optimize-gems',
			label: i18n.t('upgrade_tab.settings.optimize_gems.label'),
			labelTooltip: i18n.t('upgrade_tab.settings.optimize_gems.tooltip'),
			inline: true,
			changedEvent: () => this.optimizeGemsChangeEmitter,
			getValue: () => this.optimizeGems,
			setValue: (_eventID, _modObj, newValue) => {
				this.optimizeGems = newValue;
				this.storeSettings();
			},
		});
	}

	private async runUpgradeSim() {
		if (this.isRunning) return;

		const totalRuns = this.getTotalSimCount();
		if (totalRuns <= 1) return;

		this.progressTrackerModal.show();
		trackEvent({
			action: 'sim',
			category: 'simulate',
			label: 'upgrade_finder',
			value: totalRuns - 1,
		});

		this.isRunning = true;
		this.isCancelling = false;
		this.abortController = new AbortController();
		const abortSignal = this.abortController.signal;
		this.runButton.disabled = true;
		this.baselineResult = null;
		this.upgradeResults = [];

		let originalGear = this.simUI.player.getGear();
		try {
			await this.simUI.sim.signalManager.abortType(RequestTypes.All);
			originalGear = this.simUI.player.getGear();
			const defaultGemsByColor = this.getDefaultGemsByColor();

			let currentRun = 1;
			this.setProgress(currentRun, totalRuns, i18n.t('upgrade_tab.progress.baseline'));
			const baselineResponse = await this.runWithAbort(this.runSingleGearSim(originalGear), abortSignal);
			const baselineDps = baselineResponse.raidMetrics!.dps!;
			this.baselineResult = { gear: originalGear, dpsMetrics: baselineDps };
			currentRun++;

			const candidateResults: UpgradeResult[] = [];

			for (const candidate of this.candidateItems) {
				const eligibleSlots = this.getEligibleSlots(candidate);
				let bestResult: UpgradeResult | null = null;

				for (const slot of eligibleSlots) {
					this.throwIfAborted(abortSignal);
					this.setProgress(currentRun, totalRuns, i18n.t('upgrade_tab.progress.item', { itemName: candidate.equippedItem.item.name }));

					let candidateGear = this.buildCandidateGear(originalGear, candidate, slot, defaultGemsByColor);
					if (this.optimizeGems && this.simUI.reforger) {
						this.setProgress(currentRun, totalRuns, i18n.t('upgrade_tab.progress.optimize_gems', { itemName: candidate.equippedItem.item.name }));
						candidateGear = await this.runWithAbort(this.simUI.reforger.optimizeReforges(candidateGear, true), abortSignal);
					}
					const response = await this.runWithAbort(this.runSingleGearSim(candidateGear), abortSignal);
					const dpsMetrics = response.raidMetrics!.dps!;
					dpsMetrics.hist = [];
					dpsMetrics.allValues = [];

					const result: UpgradeResult = {
						item: candidate.equippedItem,
						slot,
						gear: candidateGear,
						dpsMetrics,
						delta: dpsMetrics.avg - baselineDps.avg,
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
			this.upgradeResults = candidateResults;
			this.renderResults();
			this.resultsTab.show();
		} catch (error) {
			console.error(error);
			if (!this.isCancelling && typeof error === 'string') {
				new Toast({ variant: 'error', body: error });
			}
		} finally {
			await this.simUI.player.setGearAsync(TypedEvent.nextEventID(), originalGear);
			this.runButton.disabled = false;
			if (this.isCancelling) {
				new Toast({
					variant: 'error',
					body: i18n.t('upgrade_tab.notifications.sim_cancelled'),
				});
			}
			this.isRunning = false;
			this.isCancelling = false;
			this.progressTrackerModal.hide();
		}
	}

	private getDefaultGemsByColor(): Map<GemColor, UIGem | null> {
		const defaultGemsByColor = new Map<GemColor, UIGem | null>();
		for (const [colorIdx, color] of [
			GemColor.GemColorRed,
			GemColor.GemColorYellow,
			GemColor.GemColorBlue,
			GemColor.GemColorMeta,
			GemColor.GemColorPrismatic,
		].entries()) {
			defaultGemsByColor.set(color, this.simUI.sim.db.lookupGem(this.fallbackGems[colorIdx].id));
		}
		return defaultGemsByColor;
	}

	private buildCandidateGear(baseGear: Gear, candidate: CandidateItem, slot: ItemSlot, defaultGemsByColor: Map<GemColor, UIGem | null>): Gear {
		let gear = baseGear;
		const currentItem = baseGear.getEquippedItem(slot);
		let updatedItem = currentItem ? currentItem.withItem(candidate.equippedItem.item) : candidate.equippedItem;

		if (candidate.selectedEnchant) {
			updatedItem = updatedItem.withEnchant(candidate.selectedEnchant);
		}

		if (candidate.equippedItem._randomSuffix) {
			updatedItem = updatedItem.withRandomSuffix(candidate.equippedItem._randomSuffix);
		}

		gear = gear.withEquippedItem(slot, updatedItem);
		gear = gear.fillSocketsWithGems(defaultGemsByColor, this.simUI.reforger?.getFrozenGemSockets());

		return gear;
	}

	private async runSingleGearSim(gear: Gear): Promise<RaidSimResult> {
		const response = await this.simUI.runSimLightweight(gear, (_progress: ProgressMetrics) => {
			// Progress is driven by the overall tracker rather than per-sim progress.
		});
		if (!response || 'type' in response) {
			throw new Error(response?.message);
		}
		return response[1];
	}

	private setProgress(current: number, total: number, title: string) {
		this.progressTrackerModal.updateProgress({
			stage: 'sim',
			title,
			current: current - 1,
			total,
		});
	}

	private async abortUpgradeSim() {
		if (this.isCancelling) return;
		this.isCancelling = true;
		try {
			await this.simUI.sim.signalManager.abortType(RequestTypes.All);
			if (!this.abortController?.signal.aborted) {
				this.abortController?.abort();
				this.abortController = null;
			}
		} finally {
			this.runButton.disabled = false;
		}
	}

	private throwIfAborted(signal: AbortSignal) {
		if (signal.aborted || this.isCancelling) {
			throw new Error('Upgrade Sim Aborted');
		}
	}

	private async runWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
		this.throwIfAborted(signal);

		let abortHandler: (() => void) | null = null;
		const abortPromise = new Promise<never>((_, reject) => {
			abortHandler = () => reject(new Error('Upgrade Sim Aborted'));
			signal.addEventListener('abort', abortHandler, { once: true });
		});

		try {
			return Promise.race([promise, abortPromise]);
		} finally {
			if (abortHandler) {
				signal.removeEventListener('abort', abortHandler);
			}
		}
	}

	private renderResults() {
		const placeholder = this.resultsTabElem.querySelector('.upgrade-results-placeholder') as HTMLElement;
		const table = this.resultsTableElem;
		const tbody = table.querySelector('tbody') as HTMLTableSectionElement;
		tbody.replaceChildren();

		if (this.upgradeResults.length === 0 || !this.baselineResult) {
			placeholder.classList.remove('hide');
			table.classList.add('hide');
			return;
		}

		placeholder.classList.add('hide');
		table.classList.remove('hide');
		const baselineAvg = this.baselineResult.dpsMetrics.avg;

		// Some items can appear multiple times in the results (e.g. imported with different
		// enchants/gems). Only show the single best instance of each item.
		const bestResultByItemId = new Map<number, UpgradeResult>();
		for (const result of this.upgradeResults) {
			const existing = bestResultByItemId.get(result.item.item.id);
			if (!existing || result.delta > existing.delta) {
				bestResultByItemId.set(result.item.item.id, result);
			}
		}
		const displayedResults = Array.from(bestResultByItemId.values()).sort((a, b) => b.delta - a.delta);

		displayedResults.forEach((result, index) => {
			const rowRef = ref<HTMLTableRowElement>();
			const itemCellRef = ref<HTMLTableCellElement>();
			const deltaRef = ref<HTMLTableCellElement>();
			const sourceCellRef = ref<HTMLTableCellElement>();
			const equipBtnRef = ref<HTMLButtonElement>();

			tbody.appendChild(
				<tr ref={rowRef}>
					<td>{index + 1}</td>
					<td ref={itemCellRef} />
					<td>{translateSlotName(result.slot)}</td>
					<td>{this.formatDps(result.dpsMetrics.avg)}</td>
					<td ref={deltaRef} />
					<td ref={sourceCellRef} />
					<td>
						<button className="btn btn-primary btn-sm" ref={equipBtnRef}>
							{i18n.t('upgrade_tab.results.equip_button')}
						</button>
					</td>
				</tr>,
			);

			const itemContainer = itemCellRef.value!;
			const renderer = new ItemRenderer(rowRef.value!, itemContainer, this.simUI.player);
			renderer.update(result.item);
			sourceCellRef.value!.appendChild(this.getSourceInfo(result.item._item));

			formatDeltaTextElem(deltaRef.value!, baselineAvg, result.dpsMetrics.avg, 2, undefined, false, true);

			const diffGearBtnRef = ref<HTMLButtonElement>();
			const actionCell = equipBtnRef.value!.parentElement as HTMLTableCellElement;
			actionCell.appendChild(
				<button className="btn btn-secondary btn-sm ms-1" ref={diffGearBtnRef}>
					{i18n.t('upgrade_tab.results.diff_button')}
				</button>,
			);
			diffGearBtnRef.value!.addEventListener('click', () => this.renderGearDiffModal(result));

			equipBtnRef.value!.addEventListener('click', () => {
				this.simUI.player.setGear(TypedEvent.nextEventID(), result.gear);
				this.simUI.simHeader.activateTab('gear-tab');
				new Toast({
					variant: 'success',
					body: i18n.t('upgrade_tab.results.gear_equipped'),
				});
			});

			const removeBtnRef = ref<HTMLButtonElement>();
			actionCell.appendChild(
				<button className="btn btn-danger btn-sm ms-1" ref={removeBtnRef} title={i18n.t('upgrade_tab.results.remove_tooltip')}>
					<i className="fas fa-times" />
				</button>,
			);
			removeBtnRef.value!.addEventListener('click', () => this.removeUpgradeResult(result));
		});

		// Baseline row.
		tbody.appendChild(
			<tr className="upgrade-results-baseline">
				<td colSpan={2}>
					<strong>{i18n.t('upgrade_tab.results.current_gear')}</strong>
				</td>
				<td />
				<td>{this.formatDps(baselineAvg)}</td>
				<td />
				<td />
				<td />
			</tr>,
		);
	}

	private removeUpgradeResult(result: UpgradeResult) {
		const resultItemId = result.item.item.id;
		const index = this.candidateItems.findIndex(candidate => candidate.spec.id === resultItemId);
		if (index === -1) return;
		const removed = this.candidateItems.splice(index, 1)[0];
		this.upgradeResults = this.upgradeResults.filter(r => r.item.item.id !== resultItemId);
		this.renderCandidateList();
		this.updateCombinationsCount();
		this.renderResults();
		this.storeSettings();
		new Toast({
			delay: 1000,
			variant: 'success',
			body: <>{i18n.t('upgrade_tab.results.item_removed', { itemName: removed.equippedItem.item.name })}</>,
		});
	}

	private formatDps(dps: number): string {
		return formatToNumber(dps);
	}

	private getSourceInfo(item: UIItem): HTMLElement {
		const makeAnchor = (href: string, inner: string | Element): HTMLElement => {
			const anchor = document.createElement('a');
			anchor.href = href;
			anchor.target = '_blank';
			anchor.dataset.whtticon = 'false';
			anchor.append(inner);
			return anchor;
		};

		if (!item.sources?.length) {
			if (item.randomSuffixOptions.length) {
				return makeAnchor(ActionId.makeItemUrl(item.id) + '#dropped-by', 'World Drop');
			}
			if (isPVPItem(item)) {
				const season = getPVPSeasonFromItem(item);
				if (season) {
					return makeAnchor(
						ActionId.makeItemUrl(item.id),
						<span>
							{season}
							<br />
							PVP
						</span>,
					);
				}
			}
			return (<></>) as unknown as HTMLElement;
		}

		let source = item.sources[0];
		if (source.source.oneofKind === 'crafted') {
			const src = source.source.crafted;
			const url = src.spellId ? ActionId.makeSpellUrl(src.spellId) : ActionId.makeItemUrl(item.id);
			return makeAnchor(url, professionNames.get(src.profession) ?? 'Unknown');
		} else if (source.source.oneofKind === 'drop') {
			const src = source.source.drop;
			const zone = this.simUI.sim.db.getZone(src.zoneId);
			const npc = this.simUI.sim.db.getNpc(src.npcId);
			if (!zone) {
				console.error('No zone found for item:', item);
				return (<></>) as unknown as HTMLElement;
			}

			if (src.category === 'Token') {
				const dropHref = npc ? ActionId.makeNpcUrl(npc.id) : ActionId.makeZoneUrl(zone.id);
				return makeAnchor(
					dropHref,
					<span>
						{zone.name}
						<br />
						{npc ? `${npc.name} (Token)` : 'Token'}
					</span>,
				);
			}

			const category = src.category ? ` - ${src.category}` : '';
			if (npc) {
				return makeAnchor(
					ActionId.makeNpcUrl(npc.id),
					<span>
						{zone.name} ({difficultyNames.get(src.difficulty) ?? 'Unknown'})
						<br />
						{npc.name + category}
					</span>,
				);
			} else if (src.otherName) {
				return makeAnchor(
					ActionId.makeZoneUrl(zone.id),
					<span>
						{zone.name}
						<br />
						{src.otherName}
					</span>,
				);
			}
			return makeAnchor(ActionId.makeZoneUrl(zone.id), zone.name);
		} else if (source.source.oneofKind === 'quest' && source.source.quest.name) {
			const src = source.source.quest;
			return makeAnchor(
				ActionId.makeQuestUrl(src.id),
				<span>
					Quest
					{item.factionRestriction === UIItem_FactionRestriction.ALLIANCE_ONLY && (
						<img src="/tbc/assets/img/alliance.png" className="ms-1" width="15" height="15" />
					)}
					{item.factionRestriction === UIItem_FactionRestriction.HORDE_ONLY && (
						<img src="/tbc/assets/img/alliance.png" className="ms-1" width="15" height="15" />
					)}
					<br />
					{src.name}
				</span>,
			);
		} else if ((source = item.sources.find(source => source.source.oneofKind === 'rep') ?? source).source.oneofKind === 'rep') {
			const factionNames = item.sources
				.filter(source => source.source.oneofKind === 'rep')
				.map(source =>
					source.source.oneofKind === 'rep' ? REP_FACTION_NAMES[source.source.rep.repFactionId] : REP_FACTION_NAMES[RepFaction.RepFactionUnknown],
				);
			const src = source.source.rep;
			const npcId = REP_FACTION_QUARTERMASTERS[src.repFactionId];
			return makeAnchor(
				ActionId.makeNpcUrl(npcId),
				<>
					{factionNames.map(name => (
						<span>
							{name}
							{item.factionRestriction === UIItem_FactionRestriction.ALLIANCE_ONLY && (
								<img src="/tbc/assets/img/alliance.png" className="ms-1" width="15" height="15" />
							)}
							{item.factionRestriction === UIItem_FactionRestriction.HORDE_ONLY && (
								<img src="/tbc/assets/img/horde.png" className="ms-1" width="15" height="15" />
							)}
							<br />
						</span>
					))}
					<span>{REP_LEVEL_NAMES[src.repLevel]}</span>
				</>,
			);
		} else if (isPVPItem(item)) {
			const season = getPVPSeasonFromItem(item);
			if (!season) return (<></>) as unknown as HTMLElement;
			return makeAnchor(
				ActionId.makeItemUrl(item.id),
				<span>
					{season}
					<br />
					PVP
				</span>,
			);
		} else if (source.source.oneofKind === 'soldBy') {
			const src = source.source.soldBy;
			return makeAnchor(
				ActionId.makeNpcUrl(src.npcId),
				<span>
					Sold by
					<br />
					{src.npcName}
				</span>,
			);
		}
		return (<></>) as unknown as HTMLElement;
	}

	private renderGearDiffModal(result: UpgradeResult) {
		const baselineGear = this.baselineResult?.gear;
		if (!baselineGear) return;

		const modal = new BaseModal(this.simUI.rootElem, 'upgrade-gear-diff-modal', {
			size: 'xl',
			title: i18n.t('upgrade_tab.results.gear_diff_title', { itemName: result.item.item.name }),
		});

		const slots = result.gear.getItemSlots();
		const rows: Element[] = [];

		slots.forEach(slot => {
			const baselineItem = baselineGear.getEquippedItem(slot);
			const candidateItem = result.gear.getEquippedItem(slot);
			if (!baselineItem && !candidateItem) return;
			if (baselineItem && candidateItem && baselineItem.equals(candidateItem)) return;

			const slotName = translateSlotName(slot);
			const baselineCell = this.renderItemCell(baselineItem);
			const candidateCell = this.renderItemCell(candidateItem);

			rows.push(
				<div className="upgrade-diff-row">
					<div className="upgrade-diff-slot">{slotName}</div>
					<div className="upgrade-diff-baseline">{baselineCell}</div>
					<div className="upgrade-diff-arrow">→</div>
					<div className="upgrade-diff-candidate">{candidateCell}</div>
				</div>,
			);
		});

		modal.body.appendChild(
			<div className="upgrade-gear-diff-body">
				{rows.length === 0 ? <div className="upgrade-diff-empty">{i18n.t('upgrade_tab.results.gear_diff_empty')}</div> : rows}
			</div>,
		);

		modal.open();
	}

	private renderItemCell(equippedItem: EquippedItem | null): Element {
		const container = document.createElement('div');
		container.className = 'upgrade-diff-item';
		if (!equippedItem) {
			container.classList.add('upgrade-diff-empty-slot');
			container.textContent = i18n.t('upgrade_tab.results.empty_slot');
			return container;
		}

		const rendererRoot = document.createElement('div');
		container.appendChild(rendererRoot);
		const renderer = new ItemRenderer(container, rendererRoot, this.simUI.player);
		renderer.update(equippedItem);

		return container;
	}
}
