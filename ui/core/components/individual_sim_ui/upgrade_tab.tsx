import { Tab } from 'bootstrap';
import clsx from 'clsx';
import { ref } from 'tsx-vanilla';

import i18n from '../../../i18n/config';
import { BaseModal } from '../base_modal';
import { IndividualSimUI } from '../../individual_sim_ui';
import { DistributionMetrics, ProgressMetrics, RaidSimResult } from '../../proto/api';
import { EquipmentSpec, GemColor, ItemSlot, ItemSpec } from '../../proto/common';
import { SimGem } from '../../proto/db';
import { RepFaction, SavedGearSet, UIEnchant, UIGem, UIItem, UIItem_FactionRestriction } from '../../proto/ui';
import { ActionId } from '../../proto_utils/action_id';
import { PresetGear } from '../../preset_utils';
import { EquippedItem } from '../../proto_utils/equipped_item';
import { Gear } from '../../proto_utils/gear';
import { Database } from '../../proto_utils/database';
import { getEmptyGemSocketIconUrl } from '../../proto_utils/gems';
import { difficultyNames, professionNames, REP_FACTION_NAMES, REP_FACTION_QUARTERMASTERS, REP_LEVEL_NAMES } from '../../proto_utils/names';
import { canEquipItem, enchantAppliesToItem, getEligibleItemSlots, getPVPSeasonFromItem, isPVPItem } from '../../proto_utils/utils';
import { RequestTypes } from '../../sim_signal_manager';
import { TypedEvent } from '../../typed_event';
import { formatDeltaTextElem, formatToNumber } from '../../utils';
import { ItemRenderer } from '../gear_picker/item_renderer';
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
import { UpgradeAddonExporter, UpgradeAddonExportRow } from './exporters/upgrade_addon_exporter';

export interface UpgradeResult {
	item: EquippedItem;
	slot: ItemSlot;
	gear: Gear;
	dpsMetrics: DistributionMetrics;
	delta: number;
	// Delta of this candidate when swapped into the BiS reference set instead of the
	// current gear (0 for the item the reference set already wears). Undefined when
	// the run had no BiS reference.
	bisDelta?: number;
}

interface SavedUpgradeRun {
	name: string;
	timestamp: number;
	items: any[];
	fallbackGems: number[];
	optimizeGems: boolean;
	compareBisEnabled: boolean;
	bisReferenceName: string;
	bisReferenceIsPreset: boolean;
	baselineResult: any;
	bisResult: any;
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
	private readonly exportAddonButton: HTMLButtonElement;
	private readonly upgradeAddonExporter: UpgradeAddonExporter<any>;

	private candidateItems: CandidateItem[] = [];
	private fallbackGems: SimGem[];
	private gemIconElements: HTMLImageElement[] = [];
	private optimizeGems = false;
	private readonly optimizeGemsChangeEmitter = new TypedEvent<void>();
	// Emitted whenever the run state changes so saved-run chips can keep their
	// active/dirty highlighting in sync with the current state.
	private readonly runStateChangeEmitter = new TypedEvent<void>();
	private savedRunsManager: SavedDataManager<UpgradeTab, SavedUpgradeRun> | null = null;
	private storageWarningShown = false;

	private isRunning = false;
	private isCancelling = false;
	private abortController: AbortController | null = null;

	private baselineResult: TopGearResult | null = null;
	private upgradeResults: UpgradeResult[] = [];

	// Optional BiS-reference comparison: when enabled and a gear set is selected,
	// runUpgradeSim runs one extra sim of that set and results show a "vs BiS" column.
	private compareBisEnabled = false;
	private readonly compareBisChangeEmitter = new TypedEvent<void>();
	private bisReferenceName: string | null = null;
	private bisReferenceIsPreset = false;
	private bisResult: TopGearResult | null = null;
	private bisSelect: HTMLSelectElement | null = null;
	private bisSelectContainer: HTMLDivElement | null = null;

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
		const exportAddonBtnRef = ref<HTMLButtonElement>();
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
								<div className="upgrade-results-toolbar">
									<button
										className="btn btn-secondary btn-sm"
										ref={exportAddonBtnRef}
										title={i18n.t('upgrade_tab.results.export_addon_tooltip_disabled')}
										disabled>
										<i className="fa fa-file-export me-1" /> {i18n.t('upgrade_tab.results.export_addon_button')}
									</button>
								</div>
								<div className="upgrade-results-placeholder">{i18n.t('upgrade_tab.results.run_simulation')}</div>
								<table className="table upgrade-results-table hide" ref={resultsTableRef}>
									<thead>
										<tr>
											<th>{i18n.t('upgrade_tab.results.rank')}</th>
											<th>{i18n.t('upgrade_tab.results.item')}</th>
											<th>{i18n.t('upgrade_tab.results.slot')}</th>
											<th>{i18n.t('upgrade_tab.results.dps')}</th>
											<th>{i18n.t('upgrade_tab.results.delta')}</th>
											<th>{i18n.t('upgrade_tab.results.delta_vs_bis')}</th>
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
							<div className="upgrade-compare-bis" ref={ref<HTMLDivElement>()} />
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
		this.exportAddonButton = exportAddonBtnRef.value!;

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

		this.upgradeAddonExporter = new UpgradeAddonExporter(
			this.simUI.rootElem,
			this.simUI,
			() => this.getDisplayedResults().map(result => this.toExportRow(result)),
			() => this.baselineResult?.dpsMetrics.avg ?? 0,
			() => this.bisResult?.dpsMetrics.avg ?? null,
		);
		this.exportAddonButton.addEventListener('click', () => this.upgradeAddonExporter.open());
		this.initPresetControls(loadPresetPhaseRef.value!, loadPresetBtnRef.value!);

		this.fallbackGems = Array.from({ length: 5 }, () => UIGem.create());

		this.runButton.addEventListener('click', () => this.runUpgradeSim());

		this.simUI.sim.waitForInit().then(async () => {
			await this.loadSettings();
			this.renderCandidateList();
			this.updateCombinationsCount();
			this.buildGemPicker();
			this.buildOptimizeGemsToggle();
			this.buildCompareBisSetting();
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
				// Never assign undefined here: a present-but-undefined "enchant" key
				// survives plain-object copies (e.g. in-session run switching, which
				// skips the JSON round trip that would drop it) and then crashes
				// ItemSpec.fromJson with "Cannot parse JSON undefined", silently
				// dropping every unenchanted candidate (neck/rings/trinkets/ranged).
				if (candidate.selectedEnchant) base.enchant = candidate.selectedEnchant.effectId;
				return base;
			}),
			fallbackGems: this.fallbackGems.map(gem => gem.id),
			optimizeGems: this.optimizeGems,
			compareBisEnabled: this.compareBisEnabled,
			bisReferenceName: this.bisReferenceName ?? '',
			bisReferenceIsPreset: this.bisReferenceIsPreset,
			baselineResult: this.baselineResult
				? {
						gear: EquipmentSpec.toJson(this.baselineResult.gear.asSpec()),
						dpsMetrics: this.metricsToJson(this.baselineResult.dpsMetrics),
					}
				: null,
			bisResult: this.bisResult
				? {
						gear: EquipmentSpec.toJson(this.bisResult.gear.asSpec()),
						dpsMetrics: this.metricsToJson(this.bisResult.dpsMetrics),
					}
				: null,
			upgradeResults: this.upgradeResults.map(result => ({
				item: ItemSpec.toJson(result.item.asSpec()),
				slot: result.slot,
				gear: EquipmentSpec.toJson(result.gear.asSpec()),
				dpsMetrics: this.metricsToJson(result.dpsMetrics),
				delta: result.delta,
				bisDelta: result.bisDelta,
			})),
		};
	}

	// hist and allValues can each contain thousands of entries and are never displayed,
	// so drop them from persisted data to stay well under the localStorage quota.
	private metricsToJson(metrics: DistributionMetrics): Record<string, any> {
		const json = DistributionMetrics.toJson(metrics) as Record<string, any>;
		delete json.hist;
		delete json.allValues;
		return json;
	}

	// Strips keys whose value is undefined before feeding stored JSON to
	// protobuf-ts fromJson. Runs serialized by older builds (or copied
	// in-memory without a JSON.stringify round trip) can carry keys like
	// "enchant": undefined, which fromJson rejects.
	private sanitizeProtoJson(json: any): any {
		if (!json || typeof json !== 'object' || Array.isArray(json)) return json;
		const clean = Object.fromEntries(Object.entries(json as Record<string, any>).filter(([, value]) => value !== undefined));
		if (Array.isArray(clean.items)) clean.items = clean.items.map((item: any) => this.sanitizeProtoJson(item));
		return clean;
	}

	// Runs may reference items that only exist in the leftover item DB (anything
	// imported via Import BiS List / presets resolves through it), which is merged
	// into the shared database only on demand. Without this, restoring such a run in
	// a fresh session would drop every leftover item from the saved state.
	private gatherRunEquipment(run: SavedUpgradeRun): EquipmentSpec {
		const items: ItemSpec[] = [];
		const pushItem = (itemJson: any) => {
			try {
				const spec = ItemSpec.fromJson(this.sanitizeProtoJson(itemJson));
				if (spec.id) items.push(spec);
			} catch {
				// Malformed entries are reported as dropped by applyRunState instead.
			}
		};
		const pushEquipment = (gearJson: any) => {
			try {
				EquipmentSpec.fromJson(gearJson).items.forEach(item => {
					if (item.id) items.push(item);
				});
			} catch {
				// Malformed entries are reported as dropped by applyRunState instead.
			}
		};

		(run.items || []).forEach(pushItem);
		pushEquipment(run.baselineResult?.gear);
		pushEquipment(run.bisResult?.gear);
		(run.upgradeResults || []).forEach(resultJson => {
			pushItem(resultJson?.item);
			pushEquipment(resultJson?.gear);
		});
		return EquipmentSpec.create({ items });
	}

	private async applyRunState(run: SavedUpgradeRun): Promise<{ droppedItems: number; droppedResults: number }> {
		// Merge the leftover item DB if the run references any items missing from the
		// main DB; otherwise every leftover item would fail lookupItemSpec below.
		const runEquipment = this.gatherRunEquipment(run);
		if (runEquipment.items.length) {
			try {
				await Database.loadLeftoversIfNecessary(runEquipment);
			} catch (error) {
				console.error('Failed to load leftover item database for saved upgrade run:', error);
			}
		}

		let droppedItems = 0;
		this.candidateItems = [];
		(run.items || []).forEach(itemJson => {
			try {
				const itemSpec = ItemSpec.fromJson(this.sanitizeProtoJson(itemJson));
				const equippedItem = this.simUI.sim.db.lookupItemSpec(itemSpec)?.withDynamicStats();
				if (!equippedItem) {
					console.warn('Saved upgrade run: item not found in database:', itemJson);
					droppedItems++;
					return;
				}
				const enchant = itemJson.enchant ? this.findEnchantForItem(itemSpec.id, itemJson.enchant) : null;
				this.candidateItems.push({ spec: itemSpec, equippedItem, selectedEnchant: enchant ?? null });
			} catch (error) {
				console.warn('Saved upgrade run: failed to restore item:', itemJson, error);
				droppedItems++;
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
		this.bisResult = this.parseStoredTopGearResult(run.bisResult);

		this.compareBisEnabled = run.compareBisEnabled ?? false;
		this.bisReferenceName = run.bisReferenceName || null;
		this.bisReferenceIsPreset = run.bisReferenceIsPreset ?? false;
		this.compareBisChangeEmitter.emit(TypedEvent.nextEventID());
		this.syncBisSettingsUi();

		let droppedResults = 0;
		this.upgradeResults = [];
		(run.upgradeResults || []).forEach(resultJson => {
			const result = this.parseStoredUpgradeResult(resultJson);
			if (result) {
				this.upgradeResults.push(result);
			} else {
				droppedResults++;
			}
		});
		return { droppedItems, droppedResults };
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
			const itemSpec = ItemSpec.fromJson(this.sanitizeProtoJson(resultJson.item));
			const item = this.simUI.sim.db.lookupItemSpec(itemSpec)?.withDynamicStats();
			if (!item) {
				console.warn('Saved upgrade run: result item not found in database:', resultJson.item);
				return null;
			}

			const equipmentSpec = EquipmentSpec.fromJson(resultJson.gear);
			const gear = this.simUI.sim.db.lookupEquipmentSpec(equipmentSpec);
			const dpsMetrics = DistributionMetrics.fromJson(resultJson.dpsMetrics);
			return {
				item,
				slot: resultJson.slot,
				gear,
				dpsMetrics,
				// Fall back to the stored delta if the baseline result didn't survive the round trip,
				// rather than reporting the raw average as if it were a gain.
				delta: this.baselineResult ? dpsMetrics.avg - this.baselineResult.dpsMetrics.avg : (resultJson.delta ?? 0),
				// Runs saved before the per-candidate reference sim have no stored bisDelta.
				bisDelta: typeof resultJson.bisDelta === 'number' ? resultJson.bisDelta : undefined,
			};
		} catch (error) {
			console.warn('Saved upgrade run: failed to restore result:', resultJson?.item, error);
			return null;
		}
	}

	private storeSettings() {
		try {
			window.localStorage.setItem(this.getSettingsKey(), JSON.stringify(this.serializeRunState()));
		} catch (e) {
			// Never delete the existing value here: the previously stored state is better
			// than no state at all when storage is full.
			console.error('Failed to persist upgrade finder state:', e);
			if (!this.storageWarningShown) {
				this.storageWarningShown = true;
				new Toast({
					delay: 6000,
					variant: 'error',
					body: i18n.t('upgrade_tab.saved_runs.storage_full'),
				});
			}
		}
		this.runStateChangeEmitter.emit(TypedEvent.nextEventID());
	}

	private async loadSettings() {
		const storedSettings = window.localStorage.getItem(this.getSettingsKey());
		if (storedSettings == null) return;

		let parsed: SavedUpgradeRun;
		try {
			parsed = JSON.parse(storedSettings);
		} catch (e) {
			// Preserve the corrupt payload instead of clobbering state or losing the data.
			console.error('Failed to parse saved upgrade finder state:', e);
			try {
				window.localStorage.setItem(`${this.getSettingsKey()}.corrupt-backup`, storedSettings);
			} catch (backupError) {
				console.error('Failed to back up corrupt upgrade finder state:', backupError);
			}
			return;
		}
		await this.applyRunState(parsed);
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
			compareBisEnabled: obj.compareBisEnabled ?? false,
			bisReferenceName: obj.bisReferenceName ?? '',
			bisReferenceIsPreset: obj.bisReferenceIsPreset ?? false,
			baselineResult: obj.baselineResult ?? null,
			bisResult: obj.bisResult ?? null,
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
			changeEmitters: [this.runStateChangeEmitter],
			getData: () => this.serializeRunState(),
			setData: (_eventID, _upgradeTab, data, name) => this.loadSavedRun(data, name),
			equals: (a, b) => this.runsEqual(a, b),
			toJson: run => this.runToJson(run),
			fromJson: obj => this.runFromJson(obj),
		});
		savedRunsManager.loadUserData();
		this.savedRunsManager = savedRunsManager;
	}

	private async loadSavedRun(run: SavedUpgradeRun, name?: string) {
		const runName = name || run.name;

		if (this.isRunning) {
			new Toast({
				delay: 3000,
				variant: 'error',
				body: i18n.t('upgrade_tab.notifications.busy_while_running'),
			});
			return;
		}

		// Guard against discarding unsaved work: only load without confirmation when the
		// current state is empty, identical to the run being loaded, or still matches
		// another saved run.
		if (this.candidateItems.length > 0 || this.upgradeResults.length > 0) {
			const currentState = this.serializeRunState();
			const matchesThisRun = this.runsEqual(currentState, run);
			const matchesSavedRun = matchesThisRun || (this.savedRunsManager?.hasMatchingData(currentState) ?? false);
			if (!matchesSavedRun && !confirm(i18n.t('upgrade_tab.saved_runs.unsaved_changes_confirm', { name: runName }))) {
				return;
			}
		}

		const { droppedItems, droppedResults } = await this.applyRunState(run);
		this.renderCandidateList();
		this.updateCombinationsCount();
		this.updateGemPickerIcons();
		this.renderResults();
		this.storeSettings();
		if (this.upgradeResults.length > 0 && this.baselineResult) {
			this.resultsTab.show();
		}
		if (droppedItems + droppedResults > 0) {
			new Toast({
				delay: 5000,
				variant: 'warning',
				body: i18n.t('upgrade_tab.saved_runs.items_not_restored', { count: droppedItems + droppedResults }),
			});
		} else {
			new Toast({
				delay: 2000,
				variant: 'success',
				body: i18n.t('upgrade_tab.saved_runs.loaded', { name: runName }),
			});
		}
	}

	// The sim loop iterates this.candidateItems live, so mutating the item list
	// mid-run would silently drop items from the results.
	private isRunningGuard(silent = false): boolean {
		if (!this.isRunning) return false;
		if (!silent) {
			new Toast({
				delay: 2000,
				variant: 'warning',
				body: i18n.t('upgrade_tab.notifications.busy_while_running'),
			});
		}
		return true;
	}

	addItem(itemSpec: ItemSpec, silent = false) {
		if (this.isRunningGuard(silent)) return;
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
		if (this.isRunningGuard()) return;
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
		if (this.isRunningGuard()) return;
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
		if (this.isRunningGuard()) return;
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
					if (this.isRunningGuard()) return;
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

	private getCandidateSimCount(): number {
		return this.candidateItems.reduce((sum, candidate) => sum + this.getEligibleSlots(candidate).length, 0);
	}

	private hasBisReferenceSim(): boolean {
		return this.compareBisEnabled && !!this.bisReferenceName;
	}

	private getTotalSimCount(): number {
		// Baseline + one sim per candidate per eligible slot, doubled when a BiS reference
		// set is selected (each candidate is also simmed on the reference set), + the
		// reference set sim itself.
		return 1 + this.getCandidateSimCount() * (this.hasBisReferenceSim() ? 2 : 1) + (this.hasBisReferenceSim() ? 1 : 0);
	}

	private updateCombinationsCount() {
		const total = this.getTotalSimCount();
		const candidateSims = this.getCandidateSimCount();
		const iterations = this.simUI.sim.getIterations() * (candidateSims * (this.hasBisReferenceSim() ? 2 : 1) + (this.hasBisReferenceSim() ? 1 : 0));
		this.runButton.disabled = total <= 1 || !this.simUI.sim.getIterations();
		this.combinationsElem.replaceChildren(
			<span>
				{candidateSims === 1 ? i18n.t('upgrade_tab.settings.sim_count_singular') : i18n.t('upgrade_tab.settings.sim_count', { count: candidateSims })}
				{this.hasBisReferenceSim() && ` ${i18n.t('upgrade_tab.settings.sim_count_bis_reference')}`}
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
			const renderer = new ItemRenderer(rowRef.value!, itemContainer, this.simUI.player, {
				slot: this.getEligibleSlots(candidate)[0],
			});
			renderer.render(candidate.selectedEnchant ? candidate.equippedItem.withEnchant(candidate.selectedEnchant) : candidate.equippedItem);

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

	private buildCompareBisSetting() {
		const container = this.settingsContainer.querySelector('.upgrade-compare-bis') as HTMLElement;
		const selectContainerRef = ref<HTMLDivElement>();
		const selectRef = ref<HTMLSelectElement>();

		new BooleanPicker<UpgradeTab>(container, this, {
			id: 'upgrade-compare-bis',
			label: i18n.t('upgrade_tab.settings.compare_bis.label'),
			labelTooltip: i18n.t('upgrade_tab.settings.compare_bis.tooltip'),
			inline: true,
			changedEvent: () => this.compareBisChangeEmitter,
			getValue: () => this.compareBisEnabled,
			setValue: (_eventID, _modObj, newValue) => {
				this.compareBisEnabled = newValue;
				this.syncBisSettingsUi();
				this.updateCombinationsCount();
				this.storeSettings();
			},
		});

		container.appendChild(
			<div className="upgrade-bis-select-container" ref={selectContainerRef}>
				<select className="form-select form-select-sm" ref={selectRef} />
			</div>,
		);

		this.bisSelectContainer = selectContainerRef.value!;
		this.bisSelect = selectRef.value!;

		// Repopulate on focus so gear sets saved/renamed in the gear tab show up
		// without a page reload.
		this.bisSelect.addEventListener('focus', () => this.populateBisSelect());
		this.bisSelect.addEventListener('change', () => {
			const value = this.bisSelect!.value;
			if (!value) {
				this.bisReferenceName = null;
				this.bisReferenceIsPreset = false;
			} else {
				// Values are encoded as "<preset|saved>:<name>"; slice at the first ':' so
				// set names containing ':' still round-trip.
				const sepIndex = value.indexOf(':');
				this.bisReferenceIsPreset = value.slice(0, sepIndex) === 'preset';
				this.bisReferenceName = value.slice(sepIndex + 1);
			}
			this.updateCombinationsCount();
			this.storeSettings();
		});

		this.populateBisSelect();
		this.syncBisSettingsUi();
	}

	private getSelectedBisValue(): string {
		return this.bisReferenceName ? `${this.bisReferenceIsPreset ? 'preset' : 'saved'}:${this.bisReferenceName}` : '';
	}

	private syncBisSettingsUi() {
		if (!this.bisSelectContainer || !this.bisSelect) return;
		this.bisSelectContainer.classList.toggle('hide', !this.compareBisEnabled);
		const desired = this.getSelectedBisValue();
		this.bisSelect.value = desired;
		if (this.bisSelect.value !== desired) {
			// The selected set no longer exists in the dropdown; leave bisReferenceName
			// intact so the run can warn about it instead of silently dropping the choice.
			this.bisSelect.value = '';
		}
	}

	private populateBisSelect() {
		if (!this.bisSelect) return;
		this.bisSelect.replaceChildren(<option value="">{i18n.t('upgrade_tab.settings.compare_bis.select_placeholder')}</option>);

		const presets = this.getPresetGearOptions();
		if (presets.length) {
			const group = (<optgroup label={i18n.t('upgrade_tab.settings.compare_bis.presets_group')} />) as HTMLOptGroupElement;
			presets.forEach(({ label }) => {
				group.appendChild((<option value={`preset:${label}`}>{label}</option>) as HTMLOptionElement);
			});
			this.bisSelect.appendChild(group);
		}

		const savedNames = this.getSavedGearSets().map(savedSet => savedSet.name);
		if (savedNames.length) {
			const group = (<optgroup label={i18n.t('upgrade_tab.settings.compare_bis.saved_group')} />) as HTMLOptGroupElement;
			savedNames.forEach(name => {
				group.appendChild((<option value={`saved:${name}`}>{name}</option>) as HTMLOptionElement);
			});
			this.bisSelect.appendChild(group);
		}

		this.syncBisSettingsUi();
	}

	// Saved gear sets live only in localStorage under the gear tab's SavedDataManager
	// key (Record<name, SavedGearSetJson>); there is no other accessor. Mirrors the
	// parse/skip-on-error behavior of SavedDataManager.loadUserData.
	private getSavedGearSets(): Array<{ name: string; data: SavedGearSet }> {
		const dataStr = window.localStorage.getItem(this.simUI.getSavedGearStorageKey());
		if (!dataStr) return [];

		let jsonData: Record<string, any>;
		try {
			jsonData = JSON.parse(dataStr);
		} catch {
			console.warn('Failed to parse saved gear sets for the BiS reference picker.');
			return [];
		}

		const sets: Array<{ name: string; data: SavedGearSet }> = [];
		for (const name in jsonData) {
			try {
				sets.push({ name, data: SavedGearSet.fromJson(jsonData[name]) });
			} catch {
				console.warn('Failed parsing saved gear set for the BiS reference picker: ', name);
			}
		}
		return sets;
	}

	// Preset gear sets can share a name (e.g. warrior 'BIS' sets per phase/group, which
	// the gear tab separates via phase tabs and group headings), so the dropdown needs
	// unique labels: duplicated names are qualified with their group/phase. The label is
	// what gets encoded in option values and persisted in saved runs, so resolving by
	// the same computed label round-trips correctly.
	private getPresetGearOptions(): Array<{ label: string; preset: PresetGear }> {
		const presets = this.simUI.individualConfig.presets.gear;
		const nameCounts = new Map<string, number>();
		presets.forEach(preset => nameCounts.set(preset.name, (nameCounts.get(preset.name) ?? 0) + 1));

		const usedLabels = new Set<string>();
		return presets.map(preset => {
			let label = preset.name;
			if ((nameCounts.get(preset.name) ?? 0) > 1) {
				const qualifiers: string[] = [];
				if (preset.group) qualifiers.push(preset.group);
				if (preset.phase !== undefined && preset.phase > 0) qualifiers.push(i18n.t(`common.phase_names.${preset.phase}`));
				if (qualifiers.length) label = `${preset.name} (${qualifiers.join(', ')})`;
				// Identical name+group+phase is still possible; number them.
				let suffix = 2;
				while (usedLabels.has(label)) label = `${label.replace(/ #\d+$/, '')} #${suffix++}`;
			}
			usedLabels.add(label);
			return { label, preset };
		});
	}

	// The reference set is simmed exactly as saved (its own items/enchants/gems).
	// SavedGearSet.bonusStatsStats is intentionally ignored: bonus stats belong to the
	// player's other settings, and the baseline sim uses the current player's too.
	private resolveBisReferenceGear(): Gear | null {
		if (!this.bisReferenceName) return null;

		const resolvePreset = (): Gear | null => {
			const preset =
				this.getPresetGearOptions().find(option => option.label === this.bisReferenceName)?.preset ??
				// Runs saved before presets had unique labels stored the bare name.
				this.simUI.individualConfig.presets.gear.find(presetGear => presetGear.name === this.bisReferenceName);
			return preset ? this.simUI.sim.db.lookupEquipmentSpec(preset.gear) : null;
		};
		const resolveSaved = (): Gear | null => {
			const saved = this.getSavedGearSets().find(savedSet => savedSet.name === this.bisReferenceName);
			return saved?.data.gear ? this.simUI.sim.db.lookupEquipmentSpec(saved.data.gear) : null;
		};

		// Fall back to the other source in case the set was re-saved under a different kind.
		return (this.bisReferenceIsPreset ? resolvePreset() : resolveSaved()) ?? (this.bisReferenceIsPreset ? resolveSaved() : resolvePreset());
	}

	private async runUpgradeSim() {
		if (this.isRunning) return;

		// Resolve the BiS reference up front so a deleted/renamed set doesn't distort
		// the progress total; warn and continue without the reference instead of failing.
		let bisGear: Gear | null = null;
		if (this.compareBisEnabled && this.bisReferenceName) {
			bisGear = this.resolveBisReferenceGear();
			if (!bisGear) {
				new Toast({
					delay: 4000,
					variant: 'warning',
					body: i18n.t('upgrade_tab.notifications.bis_set_missing', { name: this.bisReferenceName }),
				});
			}
		}

		// With a reference set, each candidate also gets simmed swapped onto that set —
		// unless the swap reproduces the reference gear exactly (the reference set already
		// wears that item), in which case the delta is 0 by definition and no sim is run.
		const isBisIdentitySwap = (candidate: CandidateItem, slot: ItemSlot): boolean => {
			if (!bisGear) return true;
			const bisCandidateGear = this.buildCandidateGear(bisGear, candidate, slot, null);
			return EquipmentSpec.equals(bisCandidateGear.asSpec(), bisGear.asSpec());
		};

		let candidateRuns = 0;
		this.candidateItems.forEach(candidate => {
			this.getEligibleSlots(candidate).forEach(slot => {
				candidateRuns += 1 + (bisGear && !isBisIdentitySwap(candidate, slot) ? 1 : 0);
			});
		});
		const totalRuns = 1 + candidateRuns + (bisGear ? 1 : 0);
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
		this.bisResult = null;
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
			baselineDps.hist = [];
			baselineDps.allValues = [];
			this.baselineResult = { gear: originalGear, dpsMetrics: baselineDps };
			currentRun++;

			if (bisGear) {
				this.throwIfAborted(abortSignal);
				this.setProgress(currentRun, totalRuns, i18n.t('upgrade_tab.progress.bis_reference'));
				const bisResponse = await this.runWithAbort(this.runSingleGearSim(bisGear), abortSignal);
				const bisDpsMetrics = bisResponse.raidMetrics!.dps!;
				bisDpsMetrics.hist = [];
				bisDpsMetrics.allValues = [];
				this.bisResult = { gear: bisGear, dpsMetrics: bisDpsMetrics };
				currentRun++;
			}

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

					// The candidate's delta within the BiS reference set: the same item swap
					// applied to the reference gear, inheriting that slot's enchant/gems.
					let bisDelta: number | undefined = undefined;
					if (bisGear && this.bisResult) {
						if (isBisIdentitySwap(candidate, slot)) {
							// The reference set already wears this exact item config.
							bisDelta = 0;
						} else {
							let bisCandidateGear = this.buildCandidateGear(bisGear, candidate, slot, null);
							if (this.optimizeGems && this.simUI.reforger) {
								bisCandidateGear = await this.runWithAbort(this.simUI.reforger.optimizeReforges(bisCandidateGear, true), abortSignal);
							}
							this.setProgress(currentRun, totalRuns, i18n.t('upgrade_tab.progress.item_on_bis', { itemName: candidate.equippedItem.item.name }));
							const bisCandidateResponse = await this.runWithAbort(this.runSingleGearSim(bisCandidateGear), abortSignal);
							const bisMetrics = bisCandidateResponse.raidMetrics!.dps!;
							bisMetrics.hist = [];
							bisMetrics.allValues = [];
							bisDelta = bisMetrics.avg - this.bisResult.dpsMetrics.avg;
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
			this.upgradeResults = candidateResults;
			this.renderResults();
			this.storeSettings();
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

	// Pass defaultGemsByColor = null (used for candidates on the BiS reference set) to keep
	// whatever gems withItem inherited from the base gear, instead of overwriting sockets
	// with the configured fallback gems — so a candidate the set already wears reproduces
	// the reference gear exactly.
	private buildCandidateGear(baseGear: Gear, candidate: CandidateItem, slot: ItemSlot, defaultGemsByColor: Map<GemColor, UIGem | null> | null): Gear {
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
		if (defaultGemsByColor) {
			gear = gear.fillSocketsWithGems(defaultGemsByColor, this.simUI.reforger?.getFrozenGemSockets());
		}

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

	// Some items can appear multiple times in the results (e.g. imported with different
	// enchants/gems). Only keep the single best instance of each item.
	private getDisplayedResults(): UpgradeResult[] {
		const bestResultByItemId = new Map<number, UpgradeResult>();
		for (const result of this.upgradeResults) {
			const existing = bestResultByItemId.get(result.item.item.id);
			if (!existing || result.delta > existing.delta) {
				bestResultByItemId.set(result.item.item.id, result);
			}
		}
		return Array.from(bestResultByItemId.values()).sort((a, b) => b.delta - a.delta);
	}

	private toExportRow(result: UpgradeResult): UpgradeAddonExportRow {
		return {
			itemId: result.item.item.id,
			slot: result.slot,
			enchantName: result.item.enchant?.name ?? '',
			gemIds: result.item.gems.filter((gem): gem is UIGem => gem != null && gem.id > 0).map(gem => gem.id),
			delta: result.delta,
			vsBisDelta: this.bisResult
				? // Runs from before the per-candidate reference sim have no bisDelta;
					// fall back to their original absolute-diff value for the export.
					(result.bisDelta ?? result.dpsMetrics.avg - this.bisResult.dpsMetrics.avg)
				: undefined,
		};
	}

	private updateExportAddonButton() {
		const disabled = this.upgradeResults.length === 0 || !this.baselineResult;
		this.exportAddonButton.disabled = disabled;
		this.exportAddonButton.title = disabled ? i18n.t('upgrade_tab.results.export_addon_tooltip_disabled') : '';
	}

	private renderResults() {
		const placeholder = this.resultsTabElem.querySelector('.upgrade-results-placeholder') as HTMLElement;
		const table = this.resultsTableElem;
		const tbody = table.querySelector('tbody') as HTMLTableSectionElement;
		tbody.replaceChildren();

		if (this.upgradeResults.length === 0 || !this.baselineResult) {
			placeholder.classList.remove('hide');
			table.classList.add('hide');
			this.updateExportAddonButton();
			return;
		}

		placeholder.classList.add('hide');
		table.classList.remove('hide');
		const baselineAvg = this.baselineResult.dpsMetrics.avg;

		const displayedResults = this.getDisplayedResults();

		displayedResults.forEach((result, index) => {
			const rowRef = ref<HTMLTableRowElement>();
			const itemCellRef = ref<HTMLTableCellElement>();
			const deltaRef = ref<HTMLTableCellElement>();
			const bisDeltaRef = ref<HTMLTableCellElement>();
			const sourceCellRef = ref<HTMLTableCellElement>();
			const equipBtnRef = ref<HTMLButtonElement>();

			tbody.appendChild(
				<tr ref={rowRef}>
					<td>{index + 1}</td>
					<td ref={itemCellRef} />
					<td>{translateSlotName(result.slot)}</td>
					<td>{this.formatDps(result.dpsMetrics.avg)}</td>
					<td ref={deltaRef} />
					<td ref={bisDeltaRef} />
					<td ref={sourceCellRef} />
					<td>
						<button className="btn btn-primary btn-sm" ref={equipBtnRef}>
							{i18n.t('upgrade_tab.results.equip_button')}
						</button>
					</td>
				</tr>,
			);

			const itemContainer = itemCellRef.value!;
			const renderer = new ItemRenderer(rowRef.value!, itemContainer, this.simUI.player, { slot: result.slot });
			renderer.render(result.item);
			sourceCellRef.value!.appendChild(this.getSourceInfo(result.item._item));

			formatDeltaTextElem(deltaRef.value!, baselineAvg, result.dpsMetrics.avg, 2, undefined, false, true);
			// result.bisDelta is a delta (candidate-on-reference minus reference), so
			// reconstruct the after-value for the formatter's percentage display.
			if (this.bisResult && result.bisDelta !== undefined) {
				const bisAvg = this.bisResult.dpsMetrics.avg;
				formatDeltaTextElem(bisDeltaRef.value!, bisAvg, bisAvg + result.bisDelta, 2, undefined, false, true);
			}

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
				<td />
			</tr>,
		);

		// BiS reference row: the reference set's DPS and its gap vs the current gear.
		if (this.bisResult) {
			const bisAvg = this.bisResult.dpsMetrics.avg;
			const bisGapRef = ref<HTMLTableCellElement>();
			tbody.appendChild(
				<tr className="upgrade-results-bis-reference">
					<td colSpan={2}>
						<strong>{i18n.t('upgrade_tab.results.bis_reference_row', { name: this.bisReferenceName ?? '' })}</strong>
					</td>
					<td />
					<td>{this.formatDps(bisAvg)}</td>
					<td ref={bisGapRef} />
					<td />
					<td />
					<td />
				</tr>,
			);
			formatDeltaTextElem(bisGapRef.value!, baselineAvg, bisAvg, 2, undefined, false, true);
		}

		this.updateExportAddonButton();
	}

	private removeUpgradeResult(result: UpgradeResult) {
		if (this.isRunningGuard()) return;
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
			const baselineCell = this.renderItemCell(baselineItem, slot);
			const candidateCell = this.renderItemCell(candidateItem, slot);

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

	private renderItemCell(equippedItem: EquippedItem | null, slot: ItemSlot): Element {
		const container = document.createElement('div');
		container.className = 'upgrade-diff-item';
		if (!equippedItem) {
			container.classList.add('upgrade-diff-empty-slot');
			container.textContent = i18n.t('upgrade_tab.results.empty_slot');
			return container;
		}

		const rendererRoot = document.createElement('div');
		container.appendChild(rendererRoot);
		const renderer = new ItemRenderer(container, rendererRoot, this.simUI.player, { slot });
		renderer.render(equippedItem);

		return container;
	}
}
