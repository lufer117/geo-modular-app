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
 *   - Los grupos (nivel 1 y 2) no tienen data-layer-id → el listener los ignora
 *
 * ── REACTIVIDAD ───────────────────────────────────────────────────────────
 * El árbol se reconstruye completamente al recibir "municipio-cargado".
 * Árbol limpio por municipio → sin riesgo de estado inconsistente.
 */

import { on, emit }        from "../utils/eventBus.js";
import { clearContainer }  from "../utils/domUtils.js";

let _containerEl = null;

// Referencias al estado del municipio activo.
// Se actualizan en cada "municipio-cargado" para que el listener
// del árbol siempre opere sobre las capas correctas.
let _layersRef  = [];
let _configsRef = [];

// ─── Inicialización ────────────────────────────────────────────────────────

export function initLayerTree(container) {
  _containerEl = typeof container === "string"
    ? document.querySelector(container)
    : container;

  if (!_containerEl) {
    console.error("[layerTree] Contenedor no encontrado:", container);
    return;
  }

  on("municipio-cargado", ({ layers, configs }) => {
    _renderTree(layers, configs);
  });
}

// ─── Renderizado principal ─────────────────────────────────────────────────

function _renderTree(layers, configs) {
  clearContainer(_containerEl);

  // Actualizar refs del municipio activo
  _layersRef  = layers;
  _configsRef = configs;

  if (!configs || configs.length === 0) {
    const msg = document.createElement("p");
    msg.className   = "layer-tree-empty";
    msg.textContent = "Sin capas disponibles para este municipio.";
    _containerEl.appendChild(msg);
    return;
  }

  const grupos = _agrupar(configs, layers);

  // ── Árbol Calcite raíz ─────────────────────────────────────────────────
  // selection-mode="ancestors": al seleccionar una hoja, el árbol marca
  // automáticamente los nodos padre (visual). Emite calciteTreeItemSelect.
  const tree = document.createElement("calcite-tree");
  tree.setAttribute("selection-mode", "ancestors");
  tree.setAttribute("lines", "");

  // ── Listener único por delegación ─────────────────────────────────────
  // POR QUÉ en el árbol raíz y no en cada item:
  //   - Un solo handler cubre todos los items del árbol
  //   - closest() filtra solo items de capa (tienen data-layer-id)
  //   - Los grupos (nivel 1 y 2) no tienen el atributo → se ignoran
  tree.addEventListener("calciteTreeItemSelect", e => {
    const item = e.target.closest("calcite-tree-item[data-layer-id]");
    if (!item) return;
    
    console.log("selected attr:", item.hasAttribute("selected"));
    console.log("e.detail:", JSON.stringify(e.detail));
    console.log("layer.visible antes:", _layersRef[parseInt(item.dataset.layerIndex)].visible);

    const layerIndex = parseInt(item.dataset.layerIndex, 10);
    const layerId    = item.dataset.layerId;

    // Calcite ya actualizó "selected" antes de emitir el evento
    const visible = !item.hasAttribute("selected"); //para evitar desfase tempora. Check activa, sin él la interacción queda invertida

    const layer  = _layersRef[layerIndex];
    const config = _configsRef[layerIndex];

    if (!layer) {
      console.warn(`[layerTree] Layer no encontrada para índice ${layerIndex}`);
      return;
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

/**
 * Crea un calcite-tree-item de capa hoja.
 *
 * POR QUÉ no hay calcite-checkbox:
 * El estado activo/inactivo lo representa "selected" en el tree-item.
 * Calcite lo gestiona visualmente (checkmark nativo). Así evitamos
 * el conflicto de eventos entre tree-item y checkbox manual.
 *
 * @param {Object} config       - Config del catálogo
 * @param {Layer}  layer        - Instancia Esri
 * @param {number} globalIndex  - Índice en el array configs/layers del municipio
 */
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

  if (config.prioridad === "P0") {
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