  // ui/headerControls.js
  // Responsabilidad: selector de idioma en la cabecera.
  

  import { DEPLOYMENT }        from "../config/deployment.js";
  import { getLang, setLang }  from "../utils/i18nManager.js";
  import { getMunicipioActivo }  from "./municipioSelector.js";
  import * as mapManager from "../core/mapManager.js";
  import { clearContainer } from "../utils/domUtils.js";
  import { on } from "../utils/eventBus.js";

  /**
   * Inicializa los controles del header.
   * Si el deployment tiene un solo idioma, no renderiza nada.
   * @param {HTMLElement} container — div#lang-selector-container
   */
  export function initHeaderControls(container) {
    if (!container) return;
    if (DEPLOYMENT.idiomas.length <= 1) return;

    _containerEl = container;
    _renderSelectorIdioma(container);
    _registrarListenersIdioma();
  }

  // ─── Privadas ─────────────────────────────────────────────────────────────────

  let _containerEl = null;
  let _idiomaListenerRegistrado = false;

  function _renderSelectorIdioma(container) {
    clearContainer(container);

    const langActivo = getLang();

    // calcite-button-group: agrupa los botones de idioma visualmente.
    // Un botón por idioma declarado en deployment.js.
    const grupo = document.createElement("calcite-button-group");

    DEPLOYMENT.idiomas.forEach(codigo => {
      const btn = document.createElement("calcite-button");
      btn.textContent  = codigo.toUpperCase();
      btn.appearance   = codigo === langActivo ? "solid" : "outline";
      btn.scale        = "s";
      btn.kind         = "neutral";

      btn.addEventListener("click", () => {
        if (codigo === getLang()) return; // ya activo, no hacer nada

        setLang(codigo, {
          municipio: getMunicipioActivo(),
          // getVistaActiva() ya no viene de toolbar — viene de mapManager directamente
          vista: mapManager.getVistaActiva()
        });
      });

      grupo.appendChild(btn);
    });

    container.appendChild(grupo);
  }

function _registrarListenersIdioma() {
  if (_idiomaListenerRegistrado) return;
  _idiomaListenerRegistrado = true;

  on("idioma-cambiado", () => {
    if (_containerEl) {
      _renderSelectorIdioma(_containerEl);
    }
  });
}