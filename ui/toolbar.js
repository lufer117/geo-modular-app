/**
 * ui/toolbar.js
 *
 * Barra de herramientas superior.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Gestionar los controles globales de la aplicación que no pertenecen
 * a un panel concreto:
 *   - Botón toggle 2D/3D
 *   - Selector de idioma 
 *   - [futuro] Buscador de dirección / geocodificador
 *   - [futuro] Herramienta de medición
 *   - [futuro] Exportar a PDF
 *
 * ── TOGGLE 2D/3D ─────────────────────────────────────────────────────────
 * Al hacer clic:
 *   1. Llama a mapManager.toggleVista() — async, espera la animación
 *   2. Actualiza texto e icono del botón
 *   3. Actualiza la referencia de legendPanel al elemento de vista activo
 *   4. Emite "vista-cambiada" en eventBus
 *
 * El botón muestra loading durante la transición para evitar dobles clics.
 */

import { t, getLang, setLang } from "../config/i18n/i18nManager.js";
import { DEPLOYMENT }          from "../config/deployment.js";
import { getMunicipioActivo }  from "./municipioSelector.js";
import * as mapManager            from "../core/mapManager.js";
import { actualizarReferencia }   from "./legendPanel.js";
import { emit }                   from "../utils/eventBus.js";

/**
 * Inicializa la toolbar en el contenedor indicado.
 * @param {HTMLElement|string} container
 */
export function initToolbar(container) {
  const el = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!el) {
    console.error("[toolbar] Contenedor no encontrado:", container);
    return;
  }

  // Botón 2D/3D — siempre presente
  el.appendChild(_crearBotonToggle());

  // Selector de idioma — solo si el deployment declara más de uno
  const idiomasDisponibles = DEPLOYMENT.idiomas ?? ["es"];
  if (idiomasDisponibles.length > 1) {
    const langContainer = document.getElementById("lang-selector-container");
    if (langContainer) {
      langContainer.appendChild(_crearSelectorIdioma(idiomasDisponibles));
    }
  }
}


// ── TOGGLE 2D/3D ─────────────────────────────────────────────────────────

// ─── Privado ──────────────────────────────────────────────────────────────

function _crearBotonToggle() {
  const btn = document.createElement("calcite-button");
  btn.id = "btn-toggle-vista";
  btn.setAttribute("icon-start", "globe");
  btn.setAttribute("appearance", "outline");
  btn.setAttribute("color", "neutral");
  btn.setAttribute("scale", "m");
  btn.textContent = t("toolbar.toggle3d"); // no hardcoded

  btn.addEventListener("click", async () => {
    // Estado de carga: previene doble clic durante la animación
    btn.setAttribute("loading", "");
    btn.disabled = true;

    try {
      const nuevoModo = await mapManager.toggleVista();

      if (nuevoModo === "3D") {
        btn.textContent = t("toolbar.toggle2d"); // no hardcoded 
        btn.setAttribute("icon-start", "map");
        // Reasignar referencia según el modo que acaba de activarse
        actualizarReferencia("scene-view"); // ← siempre scene-view aquí
      } else {
        btn.textContent = t("toolbar.toggle3d");
        btn.setAttribute("icon-start", "globe");
        // Leyenda apunta ahora al <arcgis-map>
        actualizarReferencia("map-view"); // ← siempre map-view aquí
      }

      emit("vista-cambiada", { modo: nuevoModo });

    } catch (err) {
      console.error("[toolbar] Error al cambiar vista:", err);
    } finally {
      btn.removeAttribute("loading");
      btn.disabled = false;
    }
  });

  return btn;
}

// ── SELECTOR DE IDIOMA ─────────────────────────────────────────────────────────

/**
 * Crea los botones de selección de idioma.
 * Un botón por idioma declarado en deployment.idiomas.
 * El botón del idioma activo aparece con appearance="solid".
 * Los demás con appearance="outline".
 *
 * Al pulsar un botón llama a setLang() con el estado actual de la app
 * para que el restore funcione correctamente tras el reload.
 */

function _crearSelectorIdioma(idiomas) {
  const group = document.createElement("calcite-button-group");
  group.id = "lang-selector";

  const langActivo = getLang();

  idiomas.forEach(code => {
    const btn = document.createElement("calcite-button");
    btn.setAttribute("scale", "s");
    btn.setAttribute("color", "neutral");
    btn.setAttribute(
      "appearance",
      code === langActivo ? "solid" : "outline"
    );
    btn.textContent = code.toUpperCase();
    btn.title = t("toolbar.lang.label");

    btn.addEventListener("click", () => {
      if (code === getLang()) return;
      setLang(code, {
        municipio: getMunicipioActivo(),
        vista:     mapManager.getVistaActiva()
      });
    });

    group.appendChild(btn);
  });

  return group;
}