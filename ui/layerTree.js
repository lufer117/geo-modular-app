/**
 * ui/layerTree.js
 *
 * Árbol de capas con estructura jerárquica basada en el catálogo.
 *
 * ── ESTRUCTURA DEL ÁRBOL (requisito del tutor) ───────────────────────────
 *   bloque_tematico → nivel 1  (SIN checkbox, expandible, negrita)
 *   subtema         → nivel 2  (SIN checkbox, expandible)
 *   title           → nivel 3  (CON checkbox → activa/desactiva la capa)
 *
 * Solo las hojas (capas individuales) tienen checkbox. Los grupos
 * organizan visualmente pero no actúan sobre las capas.
 *
 * ── INTERACCIÓN ──────────────────────────────────────────────────────────
 * Al marcar/desmarcar una capa:
 *   layer.visible = true/false
 *   eventBus.emit("capa-activada" | "capa-desactivada") → legendPanel reacciona
 *
 * ── REACTIVIDAD ──────────────────────────────────────────────────────────
 * El árbol se reconstruye completamente al recibir "municipio-cargado".
 * No hay estado parcial: cada nuevo municipio = nuevo árbol limpio.
 * Simple y sin riesgo de inconsistencias entre árbol y capas del Map.
 */

import { on, emit } from "../utils/eventBus.js";
import { clearContainer } from "../utils/domUtils.js";

let _containerEl = null;

// ─── Inicialización ───────────────────────────────────────────────────────

/**
 * Inicializa el árbol en el contenedor dado y suscribe los eventos necesarios.
 * @param {HTMLElement|string} container
 */
export function initLayerTree(container) {
  _containerEl = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!_containerEl) {
    console.error("[layerTree] Contenedor no encontrado:", container);
    return;
  }

  // El árbol se reconstruye cada vez que carga un nuevo municipio
  on("municipio-cargado", ({ layers, configs }) => {
    _renderTree(layers, configs);
  });
}

// ─── Renderizado ──────────────────────────────────────────────────────────

/**
 * Reconstruye el árbol de capas completo.
 * @param {Layer[]} layers  - Instancias Esri en el mismo orden que configs
 * @param {Object[]} configs - Configs del catálogo correspondientes
 */
function _renderTree(layers, configs) {
  clearContainer(_containerEl);

  if (!configs || configs.length === 0) {
    const msg = document.createElement("p");
    msg.className   = "layer-tree-empty";
    msg.textContent = "Sin capas disponibles para este municipio.";
    _containerEl.appendChild(msg);
    return;
  }

  // Construir estructura de grupos: bloque → subtema → [ {config, layer} ]
  const grupos = _agrupar(configs, layers);

  // Árbol Calcite raíz
  const tree = document.createElement("calcite-tree");
  tree.setAttribute("selection-mode", "none");  // Gestión de selección manual

  grupos.forEach(({ bloque, subtemas }) => {
    // ── Nivel 1: bloque temático (sin checkbox) ──
    const bloqueItem = _crearItemGrupo(bloque);
    const bloqueChildren = document.createElement("calcite-tree");

    subtemas.forEach(({ subtema, pares }) => {
      // ── Nivel 2: subtema (sin checkbox) ──
      const subtemaItem = _crearItemGrupo(subtema);
      const subtemaChildren = document.createElement("calcite-tree");

      pares.forEach(({ config, layer }) => {
        // ── Nivel 3: capa individual (CON checkbox) ──
        subtemaChildren.appendChild(_crearItemCapa(config, layer));
      });

      subtemaItem.appendChild(subtemaChildren);
      bloqueChildren.appendChild(subtemaItem);
    });

    bloqueItem.appendChild(bloqueChildren);
    tree.appendChild(bloqueItem);
  });

  _containerEl.appendChild(tree);
  console.info(`[layerTree] Árbol renderizado: ${configs.length} capas`);
}

// ─── Construcción de items ────────────────────────────────────────────────

/**
 * Crea un calcite-tree-item de grupo (sin checkbox, solo expansión).
 * @param {string} label
 * @returns {HTMLElement}
 */
function _crearItemGrupo(label) {
  const item = document.createElement("calcite-tree-item");
  item.setAttribute("expanded", "");  // Grupos expandidos por defecto

  const span = document.createElement("span");
  span.className   = "layer-group-label";
  span.textContent = label;
  item.appendChild(span);

  return item;
}

/**
 * Crea un calcite-tree-item de capa hoja (CON checkbox).
 * Al hacer clic en el checkbox actualiza layer.visible y emite evento.
 * @param {Object} config
 * @param {Layer}  layer
 * @returns {HTMLElement}
 */
function _crearItemCapa(config, layer) {
  const item = document.createElement("calcite-tree-item");

  const wrapper = document.createElement("div");
  wrapper.className = "layer-item-wrapper";

  // ── Checkbox Calcite ──
  const checkbox = document.createElement("calcite-checkbox");
  checkbox.id      = `chk-${config.id}`;
  checkbox.checked = layer.visible;

  checkbox.addEventListener("calciteCheckboxChange", e => {
    const visible = e.target.checked;
    layer.visible = visible;

    emit(visible ? "capa-activada" : "capa-desactivada", {
      layerId: config.id,
      layer,
      config
    });

    console.info(`[layerTree] "${config.id}" visible: ${visible}`);
  });

  // ── Etiqueta de la capa ──
  const label = document.createElement("label");
  label.htmlFor     = `chk-${config.id}`;
  label.className   = "layer-label";
  label.textContent = config.title;

  // ── Badge de prioridad (P0 = relevancia máxima, útil en defensa del TFM) ──
  wrapper.appendChild(checkbox);
  wrapper.appendChild(label);

  if (config.prioridad === "P0") {
    const badge = document.createElement("calcite-chip");
    badge.setAttribute("scale", "s");
    badge.setAttribute("kind", "brand");
    badge.textContent = "P0";
    wrapper.appendChild(badge);
  }

  // ── Indicador INSPIRE ──
  if (config.inspire) {
    const chip = document.createElement("calcite-chip");
    chip.setAttribute("scale", "s");
    chip.setAttribute("kind", "neutral");
    chip.textContent = "INSPIRE";
    wrapper.appendChild(chip);
  }

  item.appendChild(wrapper);
  return item;
}

// ─── Agrupación ──────────────────────────────────────────────────────────

/**
 * Agrupa configs + layers por bloque_tematico → subtema.
 * Preserva el orden (configs ya vienen ordenadas por prioridad desde configEngine).
 *
 * @param {Object[]} configs
 * @param {Layer[]}  layers
 * @returns {Array<{ bloque, subtemas: Array<{ subtema, pares }> }>}
 */
function _agrupar(configs, layers) {
  // LinkedMap para mantener el orden de inserción (= orden de prioridad)
  const bloqueMap = new Map();

  configs.forEach((config, i) => {
    const bloque  = config.bloque_tematico ?? "Sin categoría";
    const subtema = config.subtema         ?? "General";

    if (!bloqueMap.has(bloque)) {
      bloqueMap.set(bloque, new Map());
    }

    const subtemaMap = bloqueMap.get(bloque);
    if (!subtemaMap.has(subtema)) {
      subtemaMap.set(subtema, []);
    }

    subtemaMap.get(subtema).push({ config, layer: layers[i] });
  });

  return Array.from(bloqueMap.entries()).map(([bloque, subtemaMap]) => ({
    bloque,
    subtemas: Array.from(subtemaMap.entries()).map(([subtema, pares]) => ({
      subtema,
      pares
    }))
  }));
}