  // ui/toolbar.js
  // Responsabilidad: selector de idioma en la cabecera.
  // El toggle 2D/3D se trasladó a ui/actionBar.js

  import { DEPLOYMENT }        from "../config/deployment.js";
  import { t, getLang, setLang } from "../config/i18n/i18nManager.js";
  import { getMunicipioActivo }  from "./municipioSelector.js";
  import * as mapManager from "../core/mapManager.js";

  /**
   * Inicializa el toolbar.
   * Si el deployment tiene un solo idioma, no renderiza nada.
   * @param {HTMLElement} container — div#lang-selector-container
   */
  export function initToolbar(container) {
    if (!container) return;
    if (DEPLOYMENT.idiomas.length <= 1) return;

    _renderSelectorIdioma(container);
  }

  // ─── Privadas ─────────────────────────────────────────────────────────────────

  function _renderSelectorIdioma(container) {
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