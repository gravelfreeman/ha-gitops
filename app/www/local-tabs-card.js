console.info("local-tabs-card.js loaded");

const LOCAL_TABS_DEFAULT_CONFIG = {
  enabled: true,
  source: "local_storage",
  scope: "user",
  storage_key: "dashboard_etage",
  entity: "input_select.dashboard_etage",
  native_bubble_select: true,
  default: "rdc",
  disable_in_edit_mode: true,
  tabs: [
    { id: "sous_sol", name: "Sous-sol", match: "Sous-sol", icon: "mdi:home-floor-0" },
    { id: "rdc", name: "Rez-de-chaussée", match: "Rez-de-chaussée", icon: "mdi:home-floor-1" },
    { id: "etage", name: "Étage", match: "Étage", icon: "mdi:home-floor-2" },
    { id: "exterieur", name: "Extérieur", match: "Extérieur", icon: "mdi:home-export-outline" },
  ],
};

class LocalTabsSectionController {
  constructor() {
    this._config = LOCAL_TABS_DEFAULT_CONFIG;
    this._observer = undefined;
    this._applyTimer = undefined;
    this._bubblePatched = false;
    this._bubbleHassSetter = undefined;
    this._activeInjectedHass = undefined;

    this._boundSchedule = this.schedule.bind(this);
    this._boundStorage = this._handleStorage.bind(this);
  }

  start() {
    window.addEventListener("hashchange", this._boundSchedule);
    window.addEventListener("popstate", this._boundSchedule);
    window.addEventListener("storage", this._boundStorage);
    this._waitForBody();
    this._patchBubbleWhenReady();
    this.schedule();
  }

  configure(config) {
    window.localTabsCardConfig = config;
    this.schedule();
    this._refreshBubbleCards();
  }

  _waitForBody() {
    if (!document.body) {
      window.setTimeout(() => this._waitForBody(), 50);
      return;
    }

    if (!this._observer) {
      this._observer = new MutationObserver(this._boundSchedule);
      this._observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "edit-mode"],
      });
    }
  }

  _patchBubbleWhenReady() {
    customElements.whenDefined("bubble-card").then(() => this._patchBubbleCard());
  }

  _patchBubbleCard() {
    if (this._bubblePatched) return;

    const ctor = customElements.get("bubble-card");
    const proto = ctor?.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, "hass");
    if (!descriptor?.set) return;

    this._bubbleHassSetter = descriptor.set;
    const controller = this;

    Object.defineProperty(proto, "hass", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(hass) {
        this.__localTabsRawHass = hass;
        descriptor.set.call(this, controller._decorateHass(hass));
      },
    });

    this._bubblePatched = true;
    this._refreshBubbleCards();
  }

  schedule() {
    window.clearTimeout(this._applyTimer);
    this._applyTimer = window.setTimeout(() => this.apply(), 80);
  }

  apply() {
    this._config = this._readConfig();

    if (!this._config.enabled) {
      this._showAll();
      return;
    }

    const sections = this._findManagedSections();
    if (!sections.length) return;

    if (this._isEditing() && this._config.disable_in_edit_mode !== false) {
      this._showAll(sections);
      return;
    }

    const activeId = this._currentId();
    for (const { tab, section } of sections) {
      this._setSectionVisible(section, tab.id === activeId);
    }
  }

  _readConfig() {
    const globalConfig = window.localTabsCardConfig || {};
    const lovelaceConfig = this._findLovelaceConfig();
    const dashboardConfig = lovelaceConfig?.local_tabs_card || {};
    const merged = {
      ...LOCAL_TABS_DEFAULT_CONFIG,
      ...dashboardConfig,
      ...globalConfig,
    };

    merged.tabs = Array.isArray(merged.tabs) && merged.tabs.length
      ? merged.tabs.map((tab) => ({
          id: String(tab.id || tab.name || tab.match || "").trim(),
          name: tab.name || tab.id || tab.match,
          match: tab.match || tab.name || tab.id,
          icon: tab.icon,
        })).filter((tab) => tab.id && tab.match)
      : LOCAL_TABS_DEFAULT_CONFIG.tabs;

    return merged;
  }

  _findLovelaceConfig() {
    let found;
    this._walkDeep(document, (element) => {
      if (found) return;
      const candidates = [
        element.lovelace?.config,
        element.lovelaceConfig,
        element._lovelaceConfig,
        element.config,
      ];
      found = candidates.find((config) => Array.isArray(config?.views));
    });
    return found;
  }

  _storageKey() {
    const key = this._config.storage_key || this._config.key || "local-tabs-card";
    const scope = this._config.scope || "browser";
    const user = this._activeInjectedHass?.user?.id || this._activeInjectedHass?.user?.name;

    if ((scope === "user" || scope === "user_browser") && user) {
      return `${key}:${user}`;
    }

    return key;
  }

  _currentId() {
    const source = String(this._config.source || "local_storage").toLowerCase();
    let value = "";

    if (source === "hash") {
      value = decodeURIComponent(window.location.hash.replace(/^#/, "")).trim();
    } else if (source === "session" || source === "sessionstorage" || source === "session_storage") {
      value = window.sessionStorage.getItem(this._storageKey()) || "";
    } else {
      value = window.localStorage.getItem(this._storageKey()) || "";
    }

    const fallback = this._config.default || this._config.tabs[0]?.id;
    return this._config.tabs.some((tab) => tab.id === value) ? value : fallback;
  }

  _activeTab() {
    const activeId = this._currentId();
    return this._config.tabs.find((tab) => tab.id === activeId) || this._config.tabs[0];
  }

  _tabFromOption(option) {
    const normalized = this._normalizeText(option);
    return this._config.tabs.find((tab) =>
      [tab.id, tab.name, tab.match].some((value) => this._normalizeText(value) === normalized)
    );
  }

  _setActive(id) {
    const source = String(this._config.source || "local_storage").toLowerCase();

    if (source === "hash") {
      const nextHash = `#${encodeURIComponent(id)}`;
      if (window.location.hash !== nextHash) window.history.pushState(null, "", nextHash);
    } else if (source === "session" || source === "sessionstorage" || source === "session_storage") {
      window.sessionStorage.setItem(this._storageKey(), id);
    } else {
      window.localStorage.setItem(this._storageKey(), id);
    }

    this.schedule();
    this._refreshBubbleCards();
  }

  _handleStorage(event) {
    if (!event.key || event.key === this._storageKey()) {
      this.schedule();
      this._refreshBubbleCards();
    }
  }

  _decorateHass(hass) {
    if (!hass || !this._config?.native_bubble_select || !this._config?.entity) return hass;

    this._config = this._readConfig();
    this._activeInjectedHass = hass;

    const entityId = this._config.entity;
    const activeTab = this._activeTab();
    const now = new Date().toISOString();
    const syntheticState = {
      entity_id: entityId,
      state: activeTab?.name || "",
      attributes: {
        friendly_name: this._config.name || "Étage du dashboard",
        options: this._config.tabs.map((tab) => tab.name),
        icon: activeTab?.icon || "mdi:floor-plan",
      },
      last_changed: now,
      last_updated: now,
      context: { id: "local-tabs-card", parent_id: null, user_id: null },
    };

    const decorated = {
      ...hass,
      states: {
        ...hass.states,
        [entityId]: syntheticState,
      },
    };

    decorated.callService = (domain, service, data = {}, target = {}) => {
      const entityIds = this._normalizeEntityIds(data.entity_id ?? target.entity_id);
      const isSelect =
        (domain === "input_select" || domain === "select") &&
        service === "select_option" &&
        entityIds.includes(entityId);

      if (isSelect) {
        const tab = this._tabFromOption(data.option);
        if (tab) this._setActive(tab.id);
        return Promise.resolve();
      }

      return hass.callService(domain, service, data, target);
    };

    return decorated;
  }

  _normalizeEntityIds(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") return [value];
    return [];
  }

  _refreshBubbleCards() {
    if (!this._bubbleHassSetter) return;

    this._walkDeep(document, (element) => {
      if (element.localName !== "bubble-card" || !element.__localTabsRawHass) return;
      try {
        this._bubbleHassSetter.call(element, this._decorateHass(element.__localTabsRawHass));
      } catch (error) {
        console.warn("local-tabs-card: failed to refresh Bubble Card", error);
      }
    });
  }

  _normalizeText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  _tabForSeparatorName(name) {
    const normalized = this._normalizeText(name);
    return this._config.tabs.find((tab) => this._normalizeText(tab.match) === normalized);
  }

  _walkDeep(root, callback) {
    if (!root?.querySelectorAll) return;

    for (const element of root.querySelectorAll("*")) {
      callback(element);
      if (element.shadowRoot) this._walkDeep(element.shadowRoot, callback);
    }
  }

  _composedParent(node) {
    if (!node) return undefined;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode?.();
    return root instanceof ShadowRoot ? root.host : undefined;
  }

  _cardConfigFromElement(element) {
    return element?.config || element?._config || element?.__config;
  }

  _separatorInfo(element) {
    const config = this._cardConfigFromElement(element);
    if (config?.type !== "custom:bubble-card" || config?.card_type !== "separator") return undefined;

    const tab = this._tabForSeparatorName(config.name);
    if (!tab) return undefined;

    return { element, config, tab };
  }

  _findManagedSections() {
    const sections = [];
    const seen = new Set();

    this._walkDeep(document, (element) => {
      const info = this._separatorInfo(element);
      if (!info) return;

      const section = this._findSectionElement(element);
      if (!section || seen.has(section)) return;

      seen.add(section);
      sections.push({ ...info, section });
    });

    return sections;
  }

  _findSectionElement(element) {
    let node = element;
    let sectionHost;
    let sectionWrapper;

    while (node && node !== document.documentElement) {
      const name = node.localName || "";
      const classes = node.className?.toString?.() || "";

      if (name === "hui-grid-section" || name === "hui-section") sectionHost = node;
      if (/\bsection\b/.test(classes) && sectionHost) sectionWrapper = node;

      node = this._composedParent(node);
    }

    return sectionWrapper || sectionHost || this._findCardWrapper(element);
  }

  _findCardWrapper(element) {
    let node = element;
    while (node && node !== document.documentElement) {
      const name = node.localName || "";
      if (name === "hui-card" || name === "ha-card" || name.includes("card")) return node;
      node = this._composedParent(node);
    }
    return undefined;
  }

  _setSectionVisible(section, visible) {
    if (visible) {
      section.style.removeProperty("display");
      section.removeAttribute("aria-hidden");
      section.removeAttribute("data-local-tabs-hidden");
      return;
    }

    section.style.setProperty("display", "none", "important");
    section.setAttribute("aria-hidden", "true");
    section.setAttribute("data-local-tabs-hidden", "true");
  }

  _showAll(sections = this._findManagedSections()) {
    for (const { section } of sections) this._setSectionVisible(section, true);
  }

  _isEditing() {
    if (document.body?.classList?.contains("edit-mode")) return true;
    if (location.search.includes("edit=1") || location.search.includes("edit=true")) return true;

    let editing = false;
    this._walkDeep(document, (element) => {
      if (editing) return;

      const name = element.localName || "";
      const classes = element.className?.toString?.() || "";
      editing = Boolean(
        element.editMode === true ||
        element._editMode === true ||
        element.hasAttribute?.("edit-mode") ||
        element.hasAttribute?.("data-edit-mode") ||
        /\bedit-mode\b/.test(classes) ||
        name === "hui-card-options" ||
        name === "hui-section-options" ||
        name === "hui-dialog-edit-card" ||
        name === "hui-add-card-button" ||
        name === "ha-sortable-item"
      );
    });

    return editing;
  }
}

class LocalTabsCard extends HTMLElement {
  setConfig(config) {
    this._config = config;
    window.localTabsCardController?.configure(config);
    this._render();
  }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._render();
  }

  getCardSize() {
    return 1;
  }

  _render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `<style>:host { display: none !important; }</style>`;
  }
}

if (!customElements.get("local-tabs-card")) {
  customElements.define("local-tabs-card", LocalTabsCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((card) => card.type === "local-tabs-card")) {
  window.customCards.push({
    type: "local-tabs-card",
    name: "Local Tabs Controller",
    preview: false,
    description: "Browser-local section visibility controller with Bubble Card select integration.",
  });
}

window.localTabsCardController = window.localTabsCardController || new LocalTabsSectionController();
window.localTabsCardController.start();
