/**
 * ui/layerTree.js
 *
 * Árbol de capas jerárquico basado en Calcite Tree Web Components.
 *
 * ── ESTRUCTURA DEL ÁRBOL ─────────────────────────────────────────────────
 *   bloque_tematico → nivel 1  (SIN checkbox, expandible, negrita)
 *   subtema         → nivel 2  (SIN checkbox, expandible)
 *   title (capa)    → nivel 3  (CON checkbox → activa/desactiva la capa)
 *
 * ── POR QUÉ calcite-tree ─────────────────────────────────────────────────
 * Calcite Tree gestiona expand/collapse, teclado y ARIA de forma nativa.
 * Seguimos el patrón "Web Components first" del SDK v5: sin DOM clásico
 * manual para la jerarquía visual.
 *
 * ── SLOTS CRÍTICOS DE CALCITE TREE-ITEM (v2) ─────────────────────────────
 *   slot="children"       → árbol hijo (calcite-tree anidado)
 *   slot="actions-start"  → acciones al inicio del item (checkbox aquí)
 * Si el árbol hijo se añade como hijo directo sin slot, Calcite lo ignora
 * y renderiza los items como tarjetas apiladas — bug visual que corregimos aquí.
 *
 * ── REACTIVIDAD ──────────────────────────────────────────────────────────
 * El árbol se reconstruye completamente al recibir "municipio-cargado".
 * Árbol limpio por municipio → sin riesgo de estado inconsistente.
 */

import { on, emit } from "../utils/eventBus.js";
import { clearContainer } from "../utils/domUtils.js";

let _containerEl = null;

// ─── Inicialización ───────────────────────────────────────────────────────

/**
 * Inicializa el árbol en el contenedor dado y suscribe los eventos necesarios.
 * @param {HTMLElement|string} container - Elemento o selector CSS del contenedor
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

// ─── Renderizado principal ─────────────────────────────────────────────────

/**
 * Reconstruye el árbol de capas completo.
 * Limpia el contenedor antes de renderizar para evitar duplicados.
 *
 * @param {Layer[]}  layers  - Instancias Esri en el mismo orden que configs
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

  const grupos = _agrupar(configs, layers);

  // ── Árbol Calcite raíz ──
  // "lines" activa las líneas de conexión visual entre niveles (como IDENA)
  // "selection-mode=none" porque la selección la gestionamos con checkboxes propios
  const tree = document.createElement("calcite-tree");
  tree.setAttribute("selection-mode", "none");
  tree.setAttribute("lines", "");

  grupos.forEach(({ bloque, subtemas }) => {

    // ── Nivel 1: bloque temático ──────────────────────────────────────────
    const bloqueItem     = _crearItemGrupo(bloque, true);
    const bloqueChildren = document.createElement("calcite-tree");

    // CRÍTICO: el árbol hijo debe estar en slot="children"
    // Sin esto, Calcite no reconoce la jerarquía y apila los items como tarjetas
    bloqueChildren.slot = "children";

    subtemas.forEach(({ subtema, pares }) => {

      // ── Nivel 2: subtema ────────────────────────────────────────────────
      const subtemaItem     = _crearItemGrupo(subtema, false);
      const subtemaChildren = document.createElement("calcite-tree");
      subtemaChildren.slot  = "children"; // mismo patrón: slot obligatorio

      pares.forEach(({ config, layer }) => {
        // ── Nivel 3: capa individual (hoja con checkbox) ─────────────────
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
 * Los grupos organizan visualmente; no actúan directamente sobre capas.
 *
 * @param {string}  label    - Texto del grupo
 * @param {boolean} negrita  - true → bloque temático (nivel 1), negrita
 * @returns {HTMLElement}
 */
function _crearItemGrupo(label, negrita) {
  const item = document.createElement("calcite-tree-item");
  item.setAttribute("expanded", ""); // expandido por defecto al cargar

  const span = document.createElement("span");
  span.className   = negrita ? "layer-group-label layer-group-bloque" : "layer-group-label";
  span.textContent = label;
  item.appendChild(span);

  return item;
}

/**
 * Crea un calcite-tree-item de capa hoja (CON checkbox).
 *
 * ── Por qué checkbox en slot="actions-start" ──────────────────────────
 * Calcite Tree-Item reserva "actions-start" para acciones al inicio del
 * item. Si ponemos el checkbox como hijo directo sin slot, Calcite lo
 * trata como contenido de texto y lo posiciona incorrectamente.
 *
 * @param {Object} config - Config del catálogo
 * @param {Layer}  layer  - Instancia Esri correspondiente
 * @returns {HTMLElement}
 */
function _crearItemCapa(config, layer) {
  const item = document.createElement("calcite-tree-item");

  // ── Checkbox en slot "actions-start" ──
  const checkbox = document.createElement("calcite-checkbox");
  checkbox.id      = `chk-${config.id}`;
  checkbox.checked = layer.visible;
  checkbox.slot    = "actions-start"; // slot correcto para Calcite v2

  checkbox.addEventListener("calciteCheckboxChange", e => {
    const visible = e.target.checked;
    layer.visible = visible;

    emit(visible ? "capa-activada" : "capa-desactivada", {
      layerId: config.id,
      layer,
      config
    });

    console.info(`[layerTree] "${config.id}" → visible: ${visible}`);
  });

  // ── Etiqueta de la capa (contenido principal del item) ──
  // Va directamente en el item, sin wrapper div, para respetar el layout de Calcite
  const span = document.createElement("span");
  span.className   = "layer-label";
  span.textContent = config.title;

  item.appendChild(checkbox); // slot="actions-start" asignado arriba
  item.appendChild(span);     // contenido principal

  // ── Chips opcionales: P0 e INSPIRE ──
  // Se añaden después del span para que fluyan a la derecha
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

/**
 * Agrupa configs + layers por bloque_tematico → subtema.
 *
 * Usa Map (LinkedHashMap) para preservar el orden de inserción,
 * que coincide con el orden de prioridad que devuelve configEngine.
 * Esto garantiza que "Cartografía Base" siempre aparezca antes que
 * "Medio Ambiente" si así viene ordenado, sin lógica de ordenación adicional.
 *
 * @param {Object[]} configs
 * @param {Layer[]}  layers
 * @returns {Array<{ bloque: string, subtemas: Array<{ subtema: string, pares: Array<{config, layer}> }> }>}
 */
function _agrupar(configs, layers) {
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