/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {AnkiConnect} from '../../comm/anki-connect.js';
import {EventListenerCollection} from '../../core/event-listener-collection.js';
import {ExtensionError} from '../../core/extension-error.js';
import {log} from '../../core/log.js';
import {toError} from '../../core/to-error.js';
import {getDynamicFieldMarkers, getStandardFieldMarkers} from '../../data/anki-template-util.js';
import {stringContainsAnyFieldMarker} from '../../data/anki-util.js';
import {getRequiredPermissionsForAnkiFieldValue, hasPermissions, setPermissionsGranted} from '../../data/permissions-util.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';
import {SelectorObserver} from '../../dom/selector-observer.js';
import {ObjectPropertyAccessor} from '../../general/object-property-accessor.js';

export class AnkiController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {import('../../application.js').Application} application
     * @param {import('./modal-controller.js').ModalController} modalController
     */
    constructor(settingsController, application, modalController) {
        /** @type {import('../../application.js').Application} */
        this._application = application;
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {import('./modal-controller.js').ModalController} */
        this._modalController = modalController;
        /** @type {AnkiConnect} */
        this._ankiConnect = new AnkiConnect();
        /** @type {string} */
        this._language = 'ja';
        /** @type {SelectorObserver<AnkiCardController>} */
        this._selectorObserver = new SelectorObserver({
            selector: '.anki-card',
            ignoreSelector: null,
            onAdded: this._createCardController.bind(this),
            onRemoved: this._removeCardController.bind(this),
            isStale: this._isCardControllerStale.bind(this),
        });
        /** @type {Intl.Collator} */
        this._stringComparer = new Intl.Collator(); // Locale does not matter
        /** @type {?Promise<import('anki-controller').AnkiData>} */
        this._getAnkiDataPromise = null;
        /** @type {HTMLElement} */
        this._ankiErrorMessageNode = querySelectorNotNull(document, '#anki-error-message');
        const ankiErrorMessageNodeDefaultContent = this._ankiErrorMessageNode.textContent;
        /** @type {string} */
        this._ankiErrorMessageNodeDefaultContent = typeof ankiErrorMessageNodeDefaultContent === 'string' ? ankiErrorMessageNodeDefaultContent : '';
        /** @type {HTMLElement|null} */
        this._duplicateBehaviorSelect = document.querySelector('[data-setting="anki.duplicateBehavior"]');
        /** @type {HTMLElement} */
        this._ankiCardPrimary = querySelectorNotNull(document, '#anki-card-primary');
        /** @type {HTMLElement} */
        this._ankiCardsTabs = querySelectorNotNull(document, '#anki-cards-tabs');
        /** @type {HTMLInputElement} */
        this._ankiCardNameInput = querySelectorNotNull(document, '.anki-card-name');
        /** @type {HTMLInputElement} */
        this._ankiCardDictionaryTypeSelect = querySelectorNotNull(document, '.anki-card-type');
        /** @type {?Error} */
        this._ankiError = null;
        /** @type {?import('core').TokenObject} */
        this._validateFieldsToken = null;
        /** @type {?HTMLInputElement} */
        this._ankiEnableCheckbox = document.querySelector('[data-setting="anki.enable"]');
        /** @type {?import('settings').AnkiOptions} */
        this._ankiOptions = null;
        /** @type {number} */
        this._cardFormatIndex = 0;
        /** @type {HTMLButtonElement} */
        this._cardFormatDeleteButton = querySelectorNotNull(document, '.anki-card-delete-format-button');
        /** @type {?import('./modal.js').Modal} */
        this._cardFormatRemoveModal = null;
        /** @type {?import('./modal.js').Modal} */
        this._cardFormatMaximumModal = null;
        /** @type {HTMLElement} */
        this._cardFormatRemoveName = querySelectorNotNull(document, '#anki-card-format-remove-name');
        /** @type {HTMLButtonElement} */
        this._cardFormatRemoveConfirmButton = querySelectorNotNull(document, '#anki-card-format-remove-confirm-button');
    }

    /** @type {import('./settings-controller.js').SettingsController} */
    get settingsController() {
        return this._settingsController;
    }

    /** */
    async prepare() {
        /** @type {HTMLElement} */
        const newFormatButton = querySelectorNotNull(document, '#anki-cards-new-format button');

        if (this._ankiEnableCheckbox !== null) {
            this._ankiEnableCheckbox.addEventListener(
                /** @type {string} */ ('settingChanged'),
                /** @type {EventListener} */ (this._onAnkiEnableChanged.bind(this)),
                false,
            );
        }

        if (this._duplicateBehaviorSelect !== null) {
            this._duplicateBehaviorSelect.addEventListener('change', this._onDuplicateBehaviorSelectChange.bind(this));
        }

        await this._updateOptions();
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));

        const onAnkiSettingChanged = () => { void this._updateOptions(); };
        const nodes = document.querySelectorAll('[data-setting="anki.enable"]');
        for (const node of nodes) {
            node.addEventListener('settingChanged', onAnkiSettingChanged);
        }
        const ankiCardFormatSettingsEntry = querySelectorNotNull(document, '[data-modal-action="show,anki-cards"]');
        ankiCardFormatSettingsEntry.addEventListener('click', onAnkiSettingChanged);

        /** @type {HTMLSelectElement} */
        const ankiCardIconSelect = querySelectorNotNull(this._ankiCardPrimary, '.anki-card-icon');
        ankiCardIconSelect.addEventListener('change', this._onIconSelectChange.bind(this), false);

        this._ankiCardNameInput.addEventListener('input', () => {
            const tabLabel = querySelectorNotNull(this._ankiCardsTabs, `.tab:nth-child(${this._cardFormatIndex + 1}) .tab-label`);
            tabLabel.textContent = this._ankiCardNameInput.value || `Format ${this._cardFormatIndex + 1}`;
        });

        this._ankiCardDictionaryTypeSelect.addEventListener('change', this._onDictionaryTypeSelectChange.bind(this), false);

        newFormatButton.addEventListener('click', this._onNewFormatButtonClick.bind(this), false);

        this._cardFormatRemoveModal = this._modalController.getModal('anki-card-format-remove');
        this._cardFormatMaximumModal = this._modalController.getModal('anki-add-card-format-maximum');
        this._cardFormatDeleteButton.addEventListener('click', this._onCardFormatDeleteClick.bind(this), false);
        this._cardFormatRemoveConfirmButton.addEventListener('click', this._onCardFormatRemoveConfirm.bind(this), false);
    }

    /**
     * @returns {Promise<import('anki-controller').AnkiData>}
     */
    async getAnkiData() {
        let promise = this._getAnkiDataPromise;
        if (promise === null) {
            promise = this._getAnkiData();
            this._getAnkiDataPromise = promise;
            void promise.finally(() => { this._getAnkiDataPromise = null; });
        }
        return promise;
    }

    /**
     * @param {string} model
     * @returns {Promise<string[]>}
     */
    async getModelFieldNames(model) {
        return await this._ankiConnect.getModelFieldNames(model);
    }

    /**
     * @param {string} fieldValue
     * @returns {string[]}
     */
    getRequiredPermissions(fieldValue) {
        return getRequiredPermissionsForAnkiFieldValue(fieldValue);
    }

    // Private

    /** */
    _onIconSelectChange() {
        const iconSelect = /** @type {HTMLSelectElement} */ (this._ankiCardPrimary.querySelector('.anki-card-icon'));
        const newIcon = /** @type {import('settings').AddNoteIcon} */ (iconSelect.value);
        iconSelect.dataset.icon = newIcon;
        if (this._ankiOptions === null) { return; }
        this._ankiOptions.cardFormats[this._cardFormatIndex].icon = newIcon;
    }


    /** */
    async _updateOptions() {
        const options = await this._settingsController.getOptions();
        const optionsContext = this._settingsController.getOptionsContext();
        this._onOptionsChanged({options, optionsContext});
    }

    /**
     * @param {import('settings-controller').EventArgument<'optionsChanged'>} details
     */
    _onOptionsChanged({options: {anki, dictionaries, general: {language}}}) {
        this._ankiConnect.server = 'http://127.0.0.1:8765';
        this._ankiConnect.enabled = anki.enable;
        this._ankiConnect.apiKey = null;

        this._language = language;

        this._selectorObserver.disconnect();
        this._selectorObserver.observe(document.documentElement, true);

        this._ankiOptions = anki;
        this._updateDuplicateBehavior(anki.duplicateBehavior);
        this._setupTabs(anki);

        void this._setupFieldMenus(dictionaries);
    }

    /**
     * @param {import('dom-data-binder').SettingChangedEvent} event
     */
    _onAnkiEnableChanged({detail: {value}}) {
        if (this._ankiConnect.server === null) { return; }
        this._ankiConnect.enabled = typeof value === 'boolean' && value;

        for (const cardController of this._selectorObserver.datas()) {
            void cardController.updateAnkiState();
        }
    }

    /**
     * @param {Event} e
     */
    _onAnkiCardPrimaryTypeRadioChange(e) {
        const node = /** @type {HTMLInputElement} */ (e.currentTarget);
        if (!node.checked) { return; }
        const {cardFormatIndex, ankiCardMenu} = node.dataset;
        if (typeof cardFormatIndex !== 'string') { return; }
        this._setCardFormatIndex(Number.parseInt(cardFormatIndex, 10), ankiCardMenu);
    }

    /**
     * @param {Event} e
     */
    _onDuplicateBehaviorSelectChange(e) {
        const node = /** @type {HTMLSelectElement} */ (e.currentTarget);
        const behavior = /** @type {import('settings').AnkiDuplicateBehavior} */ (node.value);
        this._updateDuplicateBehavior(behavior);
    }

    /**
     * @param {import('settings').AnkiDuplicateBehavior} behavior
     */
    _updateDuplicateBehavior(behavior) {
        if (this._ankiCardPrimary === null) { return; }
        this._ankiCardPrimary.dataset.ankiDuplicateBehavior = behavior;
    }

    /**
     * @param {number} cardFormatIndex
     * @param {string} [ankiCardMenu]
     * @throws {Error}
     */
    _setCardFormatIndex(cardFormatIndex, ankiCardMenu) {
        this._cardFormatIndex = cardFormatIndex;
        if (this._ankiCardPrimary === null) {
            throw new Error('Anki card primary element not found');
        }
        this._ankiCardPrimary.dataset.cardFormatIndex = cardFormatIndex.toString();
        if (typeof ankiCardMenu !== 'undefined') {
            this._ankiCardPrimary.dataset.ankiCardMenu = ankiCardMenu;
        } else {
            delete this._ankiCardPrimary.dataset.ankiCardMenu;
        }

        this._ankiCardNameInput.dataset.setting = ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', cardFormatIndex, 'name']);

        /** @type {HTMLSelectElement} */
        const typeSelect = querySelectorNotNull(this._ankiCardPrimary, '.anki-card-type');
        typeSelect.dataset.setting = ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', cardFormatIndex, 'type']);

        /** @type {HTMLSelectElement} */
        const iconSelect = querySelectorNotNull(this._ankiCardPrimary, '.anki-card-icon');
        iconSelect.dataset.setting = ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', cardFormatIndex, 'icon']);
        iconSelect.dataset.icon = this._ankiOptions?.cardFormats[cardFormatIndex]?.icon ?? 'big-circle';

        /** @type {HTMLInputElement} */
        const deckInput = querySelectorNotNull(this._ankiCardPrimary, '.anki-card-deck');
        deckInput.dataset.setting = ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', cardFormatIndex, 'deck']);

        /** @type {HTMLInputElement} */
        const modelInput = querySelectorNotNull(this._ankiCardPrimary, '.anki-card-model');
        modelInput.dataset.setting = ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', cardFormatIndex, 'model']);
    }

    /**
     * Creates a new AnkiCardController for a node that matches the '.anki-card' selector.
     * This is called by the SelectorObserver when new matching nodes are added to the DOM.
     * @param {Element} node The DOM node that matches the '.anki-card' selector
     * @returns {AnkiCardController}
     */
    _createCardController(node) {
        const cardController = new AnkiCardController(this._settingsController, this, /** @type {HTMLElement} */ (node));
        void cardController.prepare();
        return cardController;
    }

    /**
     * @param {Element} _node
     * @param {AnkiCardController} cardController
     */
    _removeCardController(_node, cardController) {
        cardController.cleanup();
    }

    /**
     * @param {Element} _node
     * @param {AnkiCardController} cardController
     * @returns {boolean}
     */
    _isCardControllerStale(_node, cardController) {
        return cardController.isStale();
    }

    /**
     * @param {import('settings').DictionariesOptions} dictionaries
     */
    async _setupFieldMenus(dictionaries) {
        /** @type {[types: import('dictionary').DictionaryEntryType[], templateName: string][]} */
        const fieldMenuTargets = [
            [['term'], 'anki-card-term-field-menu'],
            [['kanji'], 'anki-card-kanji-field-menu'],
            [['term', 'kanji'], 'anki-card-all-field-menu'],
        ];
        const {templates} = this._settingsController;
        for (const [types, templateName] of fieldMenuTargets) {
            const templateContent = templates.getTemplateContent(templateName);
            if (templateContent === null) {
                log.warn(new Error(`Failed to set up menu "${templateName}": element not found`));
                continue;
            }

            const container = templateContent.querySelector('.popup-menu-body');
            if (container === null) {
                log.warn(new Error(`Failed to set up menu "${templateName}": body not found`));
                return;
            }

            while (container.firstChild) {
                container.removeChild(container.firstChild);
            }

            let markers = [];
            for (const type of types) {
                markers.push(...getStandardFieldMarkers(type, this._language));
            }
            if (types.includes('term')) {
                const dictionaryInfo = await this._application.api.getDictionaryInfo();
                markers.push(...getDynamicFieldMarkers(dictionaries, dictionaryInfo));
            }
            markers = [...new Set(markers.sort())];

            const fragment = document.createDocumentFragment();
            for (const marker of markers) {
                const option = document.createElement('button');
                option.textContent = marker;
                option.className = 'popup-menu-item popup-menu-item-thin';
                option.dataset.menuAction = 'setFieldMarker';
                option.dataset.marker = marker;
                fragment.appendChild(option);
            }
            container.appendChild(fragment);
        }
    }

    /**
     * @returns {Promise<import('anki-controller').AnkiData>}
     */
    async _getAnkiData() {
        this._setAnkiStatusChanging();
        const [
            [deckNames, getDeckNamesError],
            [modelNames, getModelNamesError],
        ] = await Promise.all([
            this._getDeckNames(),
            this._getModelNames(),
        ]);

        if (getDeckNamesError !== null) {
            this._showAnkiError(getDeckNamesError);
        } else if (getModelNamesError !== null) {
            this._showAnkiError(getModelNamesError);
        } else {
            this._hideAnkiError();
        }

        return {deckNames, modelNames};
    }

    /**
     * @returns {Promise<[deckNames: string[], error: ?Error]>}
     */
    async _getDeckNames() {
        try {
            const result = await this._ankiConnect.getDeckNames();
            this._sortStringArray(result);
            return [result, null];
        } catch (e) {
            return [[], toError(e)];
        }
    }

    /**
     * @returns {Promise<[modelNames: string[], error: ?Error]>}
     */
    async _getModelNames() {
        try {
            const result = await this._ankiConnect.getModelNames();
            this._sortStringArray(result);
            return [result, null];
        } catch (e) {
            return [[], toError(e)];
        }
    }

    /** */
    _setAnkiStatusChanging() {
        const ankiErrorMessageNode = /** @type {HTMLElement} */ (this._ankiErrorMessageNode);
        ankiErrorMessageNode.textContent = this._ankiErrorMessageNodeDefaultContent;
        ankiErrorMessageNode.classList.remove('danger-text');
    }

    /** */
    _hideAnkiError() {
        const ankiErrorMessageNode = /** @type {HTMLElement} */ (this._ankiErrorMessageNode);
        ankiErrorMessageNode.textContent = (this._ankiConnect.enabled ? 'Enabled' : 'Not enabled');
        ankiErrorMessageNode.classList.remove('danger-text');
        this._ankiError = null;
    }

    /**
     * @param {Error} error
     */
    _showAnkiError(error) {
        const ankiErrorMessageNode = /** @type {HTMLElement} */ (this._ankiErrorMessageNode);
        this._ankiError = error;
        let errorString = typeof error === 'object' && error !== null ? error.message : null;
        if (!errorString) { errorString = `${error}`; }
        if (!/[.!?]$/.test(errorString)) { errorString += '.'; }
        ankiErrorMessageNode.textContent = errorString;
        ankiErrorMessageNode.classList.add('danger-text');
    }

    /**
     * @param {string[]} array
     */
    _sortStringArray(array) {
        const stringComparer = this._stringComparer;
        array.sort((a, b) => stringComparer.compare(a, b));
    }

    /**
     * @param {import('anki').Note[]} notes
     * @returns {Promise<?((number | null)[] | null)>}
     */
    async addNotes(notes) {
        return await this._ankiConnect.addNotes(notes);
    }

    /**
     * @param {import('anki').Note[]} notes
     * @returns {Promise<boolean[]>}
     */
    async canAddNotes(notes) {
        return await this._ankiConnect.canAddNotes(notes);
    }

    /**
     * @param {import('settings').AnkiOptions} ankiOptions
     */
    _setupTabs(ankiOptions) {
        const tabsContainer = this._ankiCardsTabs;

        while (tabsContainer.firstChild) {
            tabsContainer.removeChild(tabsContainer.firstChild);
        }

        if (this._cardFormatIndex > ankiOptions.cardFormats.length) {
            this._cardFormatIndex = ankiOptions.cardFormats.length - 1;
        }
        if (this._cardFormatIndex < 0) {
            this._cardFormatIndex = 0;
        }

        for (let i = 0; i < ankiOptions.cardFormats.length; ++i) {
            const cardFormat = ankiOptions.cardFormats[i];
            const input = this._createCardFormatTab(cardFormat, i);
            if (i === this._cardFormatIndex) {
                input.checked = true;
            }
        }

        this._cardFormatDeleteButton.disabled = ankiOptions.cardFormats.length <= 1;

        this._setCardFormatIndex(this._cardFormatIndex, 'anki-card-term-field-menu');
    }

    /**
     * @param {import('settings').AnkiCardFormat} cardFormat
     * @param {number} cardFormatIndex
     * @returns {HTMLInputElement}
     */
    _createCardFormatTab(cardFormat, cardFormatIndex) {
        const tabsContainer = this._ankiCardsTabs;
        const content = this._settingsController.instantiateTemplateFragment('anki-card-type-tab');

        /** @type {HTMLInputElement} */
        const input = querySelectorNotNull(content, 'input');
        input.value = cardFormat.type;
        input.dataset.value = cardFormat.type;
        input.dataset.ankiCardMenu = `anki-card-${cardFormat.type}-field-menu`;
        input.dataset.cardFormatIndex = `${cardFormatIndex}`;
        input.addEventListener('change', this._onAnkiCardPrimaryTypeRadioChange.bind(this), false);

        /** @type {HTMLElement} */
        const labelNode = querySelectorNotNull(content, '.tab-label');
        labelNode.textContent = cardFormat.name;

        tabsContainer.appendChild(content);

        return input;
    }

    /**
     * @param {Event} e
     */
    _onNewFormatButtonClick(e) {
        e.preventDefault();
        void this._addNewFormat();
    }

    /** */
    async _addNewFormat() {
        const options = await this._settingsController.getOptions();
        const ankiOptions = options.anki;
        const index = ankiOptions.cardFormats.length;

        if (index >= 5) {
            this._cardFormatMaximumModal?.setVisible(true);
            return;
        }

        /** @type {import('settings').AnkiCardFormat} */
        const newCardFormat = {
            name: `Format ${index + 1}`,
            type: 'term',
            deck: '',
            model: '',
            fields: {},
            icon: 'big-circle',
        };

        await this._settingsController.modifyProfileSettings([{
            action: 'splice',
            path: 'anki.cardFormats',
            start: index,
            deleteCount: 0,
            items: [newCardFormat],
        }]);

        await this._updateOptions();
    }

    /**
     * @param {Event} e
     */
    _onCardFormatDeleteClick(e) {
        e.preventDefault();
        if (this._ankiOptions && this._ankiOptions.cardFormats.length === 1) { return; }
        this.openDeleteCardFormatModal(this._cardFormatIndex);
    }

    /**
     * @param {number} cardFormatIndex
     */
    openDeleteCardFormatModal(cardFormatIndex) {
        const cardFormat = this._getCardFormat(cardFormatIndex);
        if (cardFormat === null) { return; }

        /** @type {HTMLElement} */ (this._cardFormatRemoveName).textContent = cardFormat.name;
        /** @type {import('./modal.js').Modal} */ (this._cardFormatRemoveModal).node.dataset.cardFormatIndex = `${cardFormatIndex}`;
        /** @type {import('./modal.js').Modal} */ (this._cardFormatRemoveModal).setVisible(true);
    }

    /** */
    _onCardFormatRemoveConfirm() {
        const modal = /** @type {import('./modal.js').Modal} */ (this._cardFormatRemoveModal);
        modal.setVisible(false);
        const {node} = modal;
        const cardFormatIndex = node.dataset.cardFormatIndex;
        delete node.dataset.cardFormatIndex;

        const validCardFormatIndex = this._tryGetValidCardFormatIndex(cardFormatIndex);
        if (validCardFormatIndex === null) { return; }

        void this.deleteCardFormat(validCardFormatIndex);
    }

    /**
     * @param {Event} e
     */
    _onDictionaryTypeSelectChange(e) {
        const node = /** @type {HTMLSelectElement} */ (e.currentTarget);
        const value = node.value;
        this._ankiCardPrimary.dataset.ankiCardMenu = `anki-card-${value}-field-menu`;
    }

    /**
     * @param {string|undefined} stringValue
     * @returns {?number}
     */
    _tryGetValidCardFormatIndex(stringValue) {
        if (typeof stringValue !== 'string') { return null; }
        const intValue = Number.parseInt(stringValue, 10);
        if (this._ankiOptions === null) { return null; }
        return (
            Number.isFinite(intValue) &&
            intValue >= 0 &&
            intValue < this._ankiOptions.cardFormats.length ?
            intValue :
            null
        );
    }

    /**
     * @param {number} cardFormatIndex
     * @returns {?import('settings').AnkiCardFormat}
     */
    _getCardFormat(cardFormatIndex) {
        if (this._ankiOptions === null) { return null; }
        if (cardFormatIndex < 0 || cardFormatIndex >= this._ankiOptions.cardFormats.length) { return null; }
        return this._ankiOptions.cardFormats[cardFormatIndex];
    }

    /**
     * @param {number} cardFormatIndex
     */
    async deleteCardFormat(cardFormatIndex) {
        if (this._ankiOptions === null) { return; }
        const cardFormats = this._ankiOptions.cardFormats;
        if (cardFormatIndex < 0 || cardFormatIndex >= cardFormats.length) { return; }

        await this._settingsController.modifyProfileSettings([{
            action: 'splice',
            path: 'anki.cardFormats',
            start: cardFormatIndex,
            deleteCount: 1,
            items: [],
        }]);

        this._cardFormatIndex = cardFormatIndex - 1;
        await this._updateOptions();
    }
}

class AnkiCardController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     * @param {AnkiController} ankiController
     * @param {HTMLElement} node
     */
    constructor(settingsController, ankiController, node) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {AnkiController} */
        this._ankiController = ankiController;
        /** @type {HTMLElement} */
        this._node = node;
        const {cardFormatIndex} = node.dataset;
        if (typeof cardFormatIndex === 'undefined') {
            throw new Error('Undefined anki card type in node dataset');
        }
        /** @type {?import('settings').AnkiCardFormat} */
        this._cardFormat = null;
        /** @type {number} */
        this._cardFormatIndex = Number.parseInt(cardFormatIndex, 10);
        /** @type {string|undefined} */
        this._cardMenu = node.dataset.ankiCardMenu;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {EventListenerCollection} */
        this._fieldEventListeners = new EventListenerCollection();
        /** @type {import('settings').AnkiFields} */
        this._fields = {};
        /** @type {?Element} */
        this._AnkiFieldsContainer = null;
        /** @type {boolean} */
        this._cleaned = false;
        /** @type {import('anki-controller').FieldEntry[]} */
        this._fieldEntries = [];
    }

    /** */
    async prepare() {
        const options = await this._settingsController.getOptions();
        const ankiOptions = options.anki;
        if (this._cleaned) { return; }

        const cardFormat = this._getCardFormat(ankiOptions, this._cardFormatIndex);
        if (cardFormat === null) { return; }
        this._cardFormat = cardFormat;

        const {fields} = this._cardFormat;
        this._fields = fields;

        this._AnkiFieldsContainer = this._node.querySelector('.anki-card-fields');
        this._setupFields();
        this._setupAddFieldButton();

        this._eventListeners.on(this._settingsController, 'permissionsChanged', this._onPermissionsChanged.bind(this));
    }

    /** */
    cleanup() {
        this._cleaned = true;
        this._fieldEntries = [];
        this._eventListeners.removeAllEventListeners();
    }

    /** */
    async updateAnkiState() {
        // manual input mode: deck/model/fields are entered by user, no AnkiConnect fetch
    }

    /**
     * @returns {boolean}
     */
    isStale() {
        const datasetCardFormatIndex = this._node.dataset.cardFormatIndex;
        const datasetAnkiCardMenu = this._node.dataset.ankiCardMenu;
        if (typeof datasetCardFormatIndex !== 'string') { return true; }
        return this._cardFormatIndex !== Number.parseInt(datasetCardFormatIndex, 10) || this._cardMenu !== datasetAnkiCardMenu;
    }


    // Private
    /**
     * @param {number} index
     * @param {Event} e
     */
    _onFieldChange(index, e) {
        const node = /** @type {HTMLInputElement} */ (e.currentTarget);
        void this._validateFieldPermissions(node, index, true);
        this._validateField(node, index);
    }

    /**
     * @param {number} index
     * @param {Event} e
     */
    _onFieldInput(index, e) {
        const node = /** @type {HTMLInputElement} */ (e.currentTarget);
        this._validateField(node, index);
    }

    /**
     * @param {number} index
     * @param {import('dom-data-binder').SettingChangedEvent} e
     */
    _onFieldSettingChanged(index, e) {
        const node = /** @type {HTMLInputElement} */ (e.currentTarget);
        void this._validateFieldPermissions(node, index, false);
    }

    /**
     * @param {import('popup-menu').MenuOpenEvent} event
     */
    _onFieldMenuOpen(event) {
        const button = /** @type {HTMLElement} */ (event.currentTarget);
        const {menu} = event.detail;
        const {index, fieldName} = button.dataset;
        const indexNumber = typeof index === 'string' ? Number.parseInt(index, 10) : 0;
        if (typeof fieldName !== 'string') { return; }

        const defaultValue = this._getDefaultFieldValue(fieldName, indexNumber, this.cardFormatType, null);
        if (defaultValue === '') { return; }

        const match = /^\{([\w\W]+)\}$/.exec(defaultValue);
        if (match === null) { return; }

        const defaultMarker = match[1];
        const item = menu.bodyNode.querySelector(`.popup-menu-item[data-marker="${defaultMarker}"]`);
        if (item === null) { return; }

        item.classList.add('popup-menu-item-bold');
    }

    /**
     * @param {import('popup-menu').MenuCloseEvent} event
     */
    _onFieldMenuClose(event) {
        const button = /** @type {HTMLElement} */ (event.currentTarget);
        const {action, item} = event.detail;
        switch (action) {
            case 'setFieldMarker':
                if (item !== null) {
                    const {marker} = item.dataset;
                    if (typeof marker === 'string') {
                        this._setFieldMarker(button, marker);
                    }
                }
                break;
        }
    }

    /**
     * @param {HTMLInputElement} node
     * @param {number} index
     */
    _validateField(node, index) {
        let valid = (node.dataset.hasPermissions !== 'false');
        if (valid && index === 0 && !stringContainsAnyFieldMarker(node.value)) {
            valid = false;
        }
        node.dataset.invalid = `${!valid}`;
    }

    /**
     * @param {Element} element
     * @param {string} marker
     */
    _setFieldMarker(element, marker) {
        const container = element.closest('.anki-card-field-value-container');
        if (container === null) { return; }
        /** @type {HTMLInputElement} */
        const input = querySelectorNotNull(container, '.anki-card-field-value');
        input.value = `{${marker}}`;
        input.dispatchEvent(new Event('change'));
    }

    /**
     * @param {import('settings').AnkiOptions} ankiOptions
     * @param {number} cardFormatIndex
     * @returns {import('settings').AnkiCardFormat}
     * @throws {Error}
     */
    _getCardFormat(ankiOptions, cardFormatIndex) {
        const cardFormat = ankiOptions.cardFormats[cardFormatIndex];
        if (typeof cardFormat === 'undefined') {
            throw new Error('Invalid card format index');
        }
        return cardFormat;
    }

    /** */
    _setupFields() {
        this._fieldEventListeners.removeAllEventListeners();

        const totalFragment = document.createDocumentFragment();
        this._fieldEntries = [];
        let index = 0;
        for (const [fieldName, {value: fieldValue}] of Object.entries(this._fields)) {
            const content = this._settingsController.instantiateTemplateFragment('anki-card-field');

            /** @type {HTMLElement} */
            const fieldNameContainerNode = querySelectorNotNull(content, '.anki-card-field-name-container');
            fieldNameContainerNode.dataset.index = `${index}`;
            /** @type {HTMLInputElement} */
            const fieldNameNode = querySelectorNotNull(content, '.anki-card-field-name');
            fieldNameNode.value = fieldName;
            this._fieldEventListeners.addEventListener(fieldNameNode, 'blur', this._onFieldNameBlur.bind(this, index), false);

            /** @type {HTMLElement} */
            const valueContainer = querySelectorNotNull(content, '.anki-card-field-value-container');
            valueContainer.dataset.index = `${index}`;

            /** @type {HTMLSelectElement} */
            const overwriteSelect = querySelectorNotNull(content, '.anki-card-field-overwrite');
            overwriteSelect.dataset.setting = ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', this._cardFormatIndex, 'fields', fieldName, 'overwriteMode']);

            /** @type {HTMLInputElement} */
            const inputField = querySelectorNotNull(content, '.anki-card-field-value');
            inputField.value = fieldValue;
            inputField.dataset.setting = ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', this._cardFormatIndex, 'fields', fieldName, 'value']);
            void this._validateFieldPermissions(inputField, index, false);

            this._fieldEventListeners.addEventListener(inputField, 'change', this._onFieldChange.bind(this, index), false);
            this._fieldEventListeners.addEventListener(inputField, 'input', this._onFieldInput.bind(this, index), false);
            this._fieldEventListeners.addEventListener(inputField, 'settingChanged', this._onFieldSettingChanged.bind(this, index), false);
            this._validateField(inputField, index);

            /** @type {?HTMLElement} */
            const menuButton = content.querySelector('.anki-card-field-value-menu-button');
            if (menuButton !== null) {
                if (typeof this._cardMenu !== 'undefined') {
                    menuButton.dataset.menu = this._cardMenu;
                } else {
                    delete menuButton.dataset.menu;
                }
                menuButton.dataset.index = `${index}`;
                menuButton.dataset.fieldName = fieldName;
                this._fieldEventListeners.addEventListener(menuButton, 'menuOpen', this._onFieldMenuOpen.bind(this), false);
                this._fieldEventListeners.addEventListener(menuButton, 'menuClose', this._onFieldMenuClose.bind(this), false);
            }

            totalFragment.appendChild(content);
            this._fieldEntries.push({fieldName, inputField, fieldNameContainerNode});

            ++index;
        }

        const ELEMENT_NODE = Node.ELEMENT_NODE;
        const container = this._AnkiFieldsContainer;
        if (container !== null) {
            const childNodesFrozen = [...container.childNodes];
            for (const node of childNodesFrozen) {
                if (node.nodeType === ELEMENT_NODE && node instanceof HTMLElement && node.dataset.persistent === 'true') { continue; }
                container.removeChild(node);
            }
            container.appendChild(totalFragment);
        }

        void this._validateFields();
    }

    /** */
    _setupAddFieldButton() {
        const button = this._node.querySelector('.anki-card-add-field-button');
        if (button === null) { return; }
        this._eventListeners.addEventListener(button, 'click', this._onAddFieldClick.bind(this), false);
    }

    /**
     * @param {Event} _e
     */
    async _onAddFieldClick(_e) {
        if (this._fields === null) { return; }
        const baseName = 'Field';
        let name = baseName;
        let counter = 0;
        while (Object.prototype.hasOwnProperty.call(this._fields, name)) {
            name = `${baseName}${++counter}`;
        }
        const newField = /** @type {import('settings').AnkiField} */ ({value: '', overwriteMode: 'coalesce'});
        const newFields = {...this._fields, [name]: newField};
        await this._settingsController.modifyProfileSettings([{
            action: 'set',
            path: ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', this._cardFormatIndex, 'fields']),
            value: newFields,
        }]);
        this._fields = newFields;
        this._setupFields();
    }

    /**
     * @param {number} index
     * @param {Event} e
     */
    async _onFieldNameBlur(index, e) {
        const node = /** @type {HTMLInputElement} */ (e.currentTarget);
        const newName = node.value.trim();
        const entry = this._fieldEntries[index];
        if (entry === undefined) { return; }
        const oldName = entry.fieldName;
        if (newName === oldName) { return; }
        if (newName === '') {
            node.value = oldName;
            return;
        }
        if (Object.prototype.hasOwnProperty.call(this._fields, newName)) {
            node.value = oldName;
            return;
        }
        const {[oldName]: removed, ...rest} = this._fields;
        const newFields = {...rest, [newName]: removed};
        await this._settingsController.modifyProfileSettings([{
            action: 'set',
            path: ObjectPropertyAccessor.getPathString(['anki', 'cardFormats', this._cardFormatIndex, 'fields']),
            value: newFields,
        }]);
        this._fields = newFields;
        this._setupFields();
    }

    /** */
    async _validateFields() {
        // manual input mode: skip AnkiConnect validation of field names
    }

    /**
     * @param {string[]} permissions
     */
    async _requestPermissions(permissions) {
        try {
            await setPermissionsGranted({permissions}, true);
        } catch (e) {
            log.error(e);
        }
    }

    /**
     * @param {HTMLInputElement} node
     * @param {number} index
     * @param {boolean} request
     */
    async _validateFieldPermissions(node, index, request) {
        const fieldValue = node.value;
        const permissions = this._ankiController.getRequiredPermissions(fieldValue);
        if (permissions.length > 0) {
            node.dataset.requiredPermission = permissions.join(' ');
            const hasPermissions2 = await (
                request ?
                setPermissionsGranted({permissions}, true) :
                hasPermissions({permissions})
            );
            node.dataset.hasPermissions = `${hasPermissions2}`;
        } else {
            delete node.dataset.requiredPermission;
            delete node.dataset.hasPermissions;
        }

        this._validateField(node, index);
    }

    /**
     * @param {import('settings-controller').EventArgument<'permissionsChanged'>} details
     */
    _onPermissionsChanged({permissions: {permissions}}) {
        const permissionsSet = new Set(permissions);
        for (let i = 0, ii = this._fieldEntries.length; i < ii; ++i) {
            const {inputField} = this._fieldEntries[i];
            const {requiredPermission} = inputField.dataset;
            if (typeof requiredPermission !== 'string') { continue; }
            const requiredPermissionArray = (requiredPermission.length === 0 ? [] : requiredPermission.split(' '));

            let hasPermissions2 = true;
            for (const permission of requiredPermissionArray) {
                if (!permissionsSet.has(permission)) {
                    hasPermissions2 = false;
                    break;
                }
            }

            inputField.dataset.hasPermissions = `${hasPermissions2}`;
            this._validateField(inputField, i);
        }
    }

    /**
     * @param {string} fieldName
     * @param {number} index
     * @param {import('dictionary').DictionaryEntryType} dictionaryEntryType
     * @param {?import('settings').AnkiFields} oldFields
     * @returns {string}
     */
    _getDefaultFieldValue(fieldName, index, dictionaryEntryType, oldFields) {
        if (
            typeof oldFields === 'object' &&
            oldFields !== null &&
            Object.prototype.hasOwnProperty.call(oldFields, fieldName)
        ) {
            return oldFields[fieldName].value;
        }

        if (index === 0) {
            return (dictionaryEntryType === 'kanji' ? '{character}' : '{expression}');
        }

        const markers = getStandardFieldMarkers(dictionaryEntryType);
        const markerAliases = new Map([
            ['expression', ['phrase', 'term', 'word']],
            ['reading', ['expression-reading', 'term-reading', 'word-reading']],
            ['furigana', ['expression-furigana', 'term-furigana', 'word-furigana']],
            ['glossary', ['definition', 'meaning']],
            ['audio', ['sound', 'word-audio', 'term-audio', 'expression-audio']],
            ['dictionary', ['dict']],
            ['pitch-accents', ['pitch', 'pitch-accent', 'pitch-pattern']],
            ['sentence', ['example-sentence']],
            ['frequency-harmonic-rank', ['freq', 'frequency', 'freq-sort', 'freqency-sort']],
            ['popup-selection-text', ['selection']],
            ['pitch-accent-positions', ['pitch-position']],
            ['pitch-accent-categories', ['pitch-categories']],
            ['popup-selection-text', ['selection-text']],
        ]);

        const hyphenPattern = /-/g;
        for (const marker of markers) {
            const names = [marker];
            const aliases = markerAliases.get(marker);
            if (typeof aliases !== 'undefined') {
                names.push(...aliases);
            }

            let pattern = '^(?:';
            for (let i = 0, ii = names.length; i < ii; ++i) {
                const name = names[i];
                if (i > 0) { pattern += '|'; }
                pattern += name.replace(hyphenPattern, '[-_ ]*');
            }
            pattern += ')$';
            const patternRegExp = new RegExp(pattern, 'i');

            if (patternRegExp.test(fieldName)) {
                return `{${marker}}`;
            }
        }

        return '';
    }

    /** @type {import('dictionary').DictionaryEntryType} */
    get cardFormatType() {
        if (this._cardFormat === null) {
            throw new Error('Card format not initialized');
        }
        return this._cardFormat.type;
    }
}
