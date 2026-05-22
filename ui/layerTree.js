/**
 * ui/layerTree.js
 *
 * Árbol de capas jerárquico basado en Calcite Tree Web Components.
 *
 * ── ESTRUCTURA DEL ÁRBOL ──────────────────────────────────────────────────
 *   bloque_tematico → nivel 1  (SIN checkbox, expandible, negrita)
 *   subtema         → nivel 2  (SIN checkbox, expandible)
 *   title (capa)    → nivel 3  (seleccionable → activa/desactiva la capa)
 *
 * ── POR QUÉ selection-mode="ancestors" y NO calcite-checkbox manual ───────
 * calcite-tree-item intercepta todos los pointer events para su mecanismo
 * de selección nativo. Añadir calcite-checkbox como hijo provoca que el
 * click lo consuma el item antes de llegar al checkbox →
 * calciteCheckboxChange nunca se dispara.
 *
 * La solución correcta: usar el mecanismo nativo de Calcite Tree.
 *   - selection-mode="ancestors" → emite calciteTreeItemSelect en cada cambio
 *   - Un listener único en el árbol raíz (delegación de eventos)
 *   - data-layer-id + data-layer-index identifican qué capa toglear
 *   - Los grupos (nivel 1 y 2) no tienen data-layer-id → el listener los ignoran
 *
 * ── REACTIVIDAD ───────────────────────────────────────────────────────────
 * El árbol se reconstruye completamente al recibir "municipio-cargado".
 * Árbol limpio por municipio → sin riesgo de estado inconsistente.
 */

import { on, emit }       from "../utils/eventBus.js";
import { clearContainer } from "../utils/domUtils.js";
import * as mapManager    from "../core/mapManager.js";

let _containerEl = null;
let _layersRef   = [];
let _configsRef  = [];
let _lazyLayerIds = new Set();

// ─── Inicialización ────────────────────────────────────────────────────────

export function initLayerTree(container) {
  _containerEl = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!_containerEl) {
    console.error("[layerTree] Contenedor no encontrado:", container);
    return;
  }

  // Mensaje inicial — layerTree es dueño único de este contenedor.
  // Se elimina en _renderTree via clearContainer cuando llegue municipio-cargado.
  const msg = document.createElement("p");
  msg.className   = "layer-tree-empty";
  msg.textContent = "Selecciona un municipio para ver las capas disponibles.";
  _containerEl.appendChild(msg);

  on("municipio-cargado", ({ layers, configs, lazyLayerIds }) => {
    _renderTree(layers, configs, lazyLayerIds ?? new Set());
  });
}

// ─── Renderizado principal ─────────────────────────────────────────────────

function _renderTree(layers, configs, lazyLayerIds) {
  // CRÍTICO: limpiar el contenedor antes de renderizar.
  // Elimina el mensaje inicial y cualquier árbol de municipio anterior.
  clearContainer(_containerEl);

  _lazyLayerIds = lazyLayerIds;
  _layersRef    = layers;
  _configsRef   = configs;

  if (!configs || configs.length === 0) {
    const msg = document.createElement("p");
    msg.className   = "layer-tree-empty";
    msg.textContent = "Sin capas disponibles para este municipio.";
    _containerEl.appendChild(msg);
    return;
  }

  const grupos = _agrupar(configs, layers);

  const tree = document.createElement("calcite-tree");
  tree.setAttribute("selection-mode", "ancestors");
  tree.setAttribute("lines", "");

  tree.addEventListener("calciteTreeItemSelect", e => {
    const item = e.target.closest("calcite-tree-item[data-layer-id]");
    if (!item) return;

    const layerIndex = parseInt(item.dataset.layerIndex, 10);
    const layerId    = item.dataset.layerId;

    // Calcite actualiza "selected" antes de emitir el evento.
    // La negación evita el desfase temporal de la prop selected.
    const visible = !item.hasAttribute("selected");

    const layer  = _layersRef[layerIndex];
    const config = _configsRef[layerIndex];

    if (!layer) {
      console.warn(`[layerTree] Layer no encontrada para índice ${layerIndex}`);
      return;
    }

    // Lazy-load: WFS entra al mapa solo la primera vez que el usuario la activa.
    // layer.map es null si la capa no está en ningún mapa todavía.
    if (visible && _lazyLayerIds.has(layerId) && !layer.map) {
      mapManager.addCapa(layer);
    }

    layer.visible = visible;
    emit(visible ? "capa-activada" : "capa-desactivada", { layerId, layer, config });
    console.info(`[layerTree] "${layerId}" → visible: ${visible}`);
  });

  grupos.forEach(({ bloque, subtemas }) => {
    const bloqueItem     = _crearItemGrupo(bloque, true);
    const bloqueChildren = document.createElement("calcite-tree");
    bloqueChildren.slot  = "children";

    subtemas.forEach(({ subtema, pares }) => {
      const subtemaItem     = _crearItemGrupo(subtema, false);
      const subtemaChildren = document.createElement("calcite-tree");
      subtemaChildren.slot  = "children";

      pares.forEach(({ config, layer }) => {
        const globalIndex = configs.indexOf(config);
        subtemaChildren.appendChild(_crearItemCapa(config, layer, globalIndex));
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

// ─── Construcción de items ─────────────────────────────────────────────────

function _crearItemGrupo(label, negrita) {
  const item = document.createElement("calcite-tree-item");
  item.setAttribute("expanded", "");

  const span = document.createElement("span");
  span.className   = negrita
    ? "layer-group-label layer-group-bloque"
    : "layer-group-label";
  span.textContent = label;
  item.appendChild(span);

  return item;
}

function _crearItemCapa(config, layer, globalIndex) {
  const item = document.createElement("calcite-tree-item");
  item.dataset.layerId    = config.id;
  item.dataset.layerIndex = globalIndex;

  if (layer.visible) {
    item.setAttribute("selected", "");
  }

  const span = document.createElement("span");
  span.className   = "layer-label";
  span.textContent = config.title;
  item.appendChild(span);

  if (config.prioridad === "P0 - MVP") {
    const badge = document.createElement("calcite-chip");
    badge.setAttribute("scale", "s");
    badge.setAttribute("kind", "brand");
    badge.textContent = "P0";
    item.appendChild(badge);
  }

  if (config.inspire) {
    const chip = document.createElement("calcite-chip");
    chip.setAttribute("scale", "s");
    chip.setAttribute("kind", "neutral");
    chip.textContent = "INSPIRE";
    item.appendChild(chip);
  }

  return item;
}

// ─── Agrupación ───────────────────────────────────────────────────────────

function _agrupar(configs, layers) {
  const bloqueMap = new Map();

  configs.forEach((config, i) => {
    const bloque  = config.bloque_tematico ?? "Sin categoría";
    const subtema = config.subtema         ?? "General";

    if (!bloqueMap.has(bloque)) bloqueMap.set(bloque, new Map());
    const subtemaMap = bloqueMap.get(bloque);
    if (!subtemaMap.has(subtema)) subtemaMap.set(subtema, []);
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