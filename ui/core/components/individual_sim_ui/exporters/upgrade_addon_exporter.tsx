import i18n from '../../../../i18n/config';
import { IndividualSimUI } from '../../../individual_sim_ui';
import { ItemSlot, Spec } from '../../../proto/common';
import { IndividualExporter } from './individual_exporter';

export interface UpgradeAddonExportRow {
	itemId: number;
	// Raw proto ItemSlot enum value (0-16); the addon maps it to a display name.
	slot: ItemSlot;
	// Enchant display name (effectId is sim-internal and useless in-game). May be ''.
	enchantName: string;
	// Real WoW item IDs of the gems socketed into the item.
	gemIds: number[];
	delta: number;
	// DPS delta vs the BiS reference set. Present only when the run included one.
	vsBisDelta?: number;
}

// Produces the import string for the WoWSimsUpgradeList WoW addon:
//
//	WWSULv2|<listName>|<specFriendlyName>|<unixTimestamp>|<baselineDps>
//	<slot>:<itemId>:<enchantName>:<gemId1>,<gemId2>,...:<delta>
//	...
//
// When the upgrade run included a BiS reference set, the format is bumped to v3
// (old addon versions should reject it rather than misparsing):
//
//	WWSULv3|<listName>|<specFriendlyName>|<unixTimestamp>|<baselineDps>|<bisDps>
//	<slot>:<itemId>:<enchantName>:<gemId1>,<gemId2>,...:<delta>:<vsBisDelta>
export class UpgradeAddonExporter<SpecType extends Spec> extends IndividualExporter<SpecType> {
	private readonly getRows: () => UpgradeAddonExportRow[];
	private readonly getBaselineDps: () => number;
	private readonly getBisDps: () => number | null;

	constructor(
		parent: HTMLElement,
		simUI: IndividualSimUI<SpecType>,
		getRows: () => UpgradeAddonExportRow[],
		getBaselineDps: () => number,
		getBisDps: () => number | null,
	) {
		super(parent, simUI, {
			title: i18n.t('upgrade_tab.results.export_addon_title'),
			selectCategories: false,
		});
		this.getRows = getRows;
		this.getBaselineDps = getBaselineDps;
		this.getBisDps = getBisDps;
	}

	getData(): string {
		const sanitize = (s: string) => s.replace(/[|:\r\n]/g, ' ').trim();

		const specName = sanitize(this.simUI.player.getPlayerSpec().friendlyName);
		const listName = sanitize(`${specName} Upgrades`);
		const timestamp = Math.floor(Date.now() / 1000);
		const bisDps = this.getBisDps();

		const header =
			bisDps == null
				? `WWSULv2|${listName}|${specName}|${timestamp}|${this.getBaselineDps().toFixed(1)}`
				: `WWSULv3|${listName}|${specName}|${timestamp}|${this.getBaselineDps().toFixed(1)}|${bisDps.toFixed(1)}`;

		const lines = this.getRows().map(row => {
			const line = `${row.slot}:${row.itemId}:${sanitize(row.enchantName)}:${row.gemIds.join(',')}:${row.delta.toFixed(1)}`;
			return bisDps == null ? line : `${line}:${(row.vsBisDelta ?? 0).toFixed(1)}`;
		});
		return [header, ...lines].join('\n');
	}
}
