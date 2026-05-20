/**
 * ui/toolbar.js
 *
 * Barra de herramientas superior.
 *
 * ── RESPONSABILIDAD ──────────────────────────────────────────────────────
 * Gestionar los controles globales de la aplicación que no pertenecen
 * a un panel concreto:
 *   - Botón toggle 2D/3D
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

  el.appendChild(_crearBotonToggle());
}

// ─── Privado ──────────────────────────────────────────────────────────────

function _crearBotonToggle() {
  const btn = document.createElement("calcite-button");
  btn.id = "btn-toggle-vista";
  btn.setAttribute("icon-start", "globe");
  btn.setAttribute("appearance", "outline");
  btn.setAttribute("color", "neutral");
  btn.setAttribute("scale", "m");
  btn.textContent = "Vista 3D";

  btn.addEventListener("click", async () => {
    // Estado de carga: previene doble clic durante la animación
    btn.setAttribute("loading", "");
    btn.disabled = true;

    try {
      const nuevoModo = await mapManager.toggleVista();

      if (nuevoModo === "3D") {
        btn.textContent = "Vista 2D";
        btn.setAttribute("icon-start", "map");
        // Reasignar referencia según el modo que acaba de activarse
        actualizarReferencia(
          nuevoModo === "3D"
          ? "scene-view"
          : "map-view"
        );
      } else {
        btn.textContent = "Vista 3D";
        btn.setAttribute("icon-start", "globe");
        // Leyenda apunta ahora al <arcgis-map>
        actualizarReferencia("map-view");
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