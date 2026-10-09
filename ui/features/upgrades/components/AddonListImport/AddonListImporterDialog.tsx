import { Importer } from '@features/import-export';
import i18n from '@i18n/config';
import { addonListStringExample } from '@sim/upgrade/addon_list_parser';

import { UPGRADE_LIST_IMPORTER } from '../../model/addon_list_import';

export interface AddonListImporterDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export const AddonListImporterDialog = ({ open, onOpenChange }: AddonListImporterDialogProps) => (
	<Importer open={open} onOpenChange={onOpenChange} {...UPGRADE_LIST_IMPORTER}>
		<p>{i18n.t('upgrade_tab.import_addon_list.description')}</p>
		<p>{i18n.t('upgrade_tab.import_addon_list.instructions')}</p>
		<details className="bis-list-example">
			<summary>{i18n.t('upgrade_tab.import_addon_list.example_summary')}</summary>
			<pre className="bis-list-example-code">
				<code>{addonListStringExample()}</code>
			</pre>
		</details>
	</Importer>
);
