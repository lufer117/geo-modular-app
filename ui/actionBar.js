/**
 * ui/actionBar.js
 *
 * Gestiona el action bar lateral y sus paneles asociados.
 * Solo controla: apertura/cierre de paneles.
 *
 * El toggle 2D/3D se movió a ui/mapControls.js (SRP:
 * los controles del mapa son responsabilidad del módulo de controles,
 * no del panel lateral).
 */

import * as eventBus from "../utils/eventBus.js";

// ─── Referencias DOM ──────────────────────────────────────────────────────────
let _actionBar       = null;
let _panelCapas      = null;
let _actionCapas     = null;
let _shellPanelStart = null;

// ─── API pública ──────────────────────────────────────────────────────────────

export function initActionBar() {
  _resolverReferencias();
  _registrarListeners();
}

// ─── Privadas ─────────────────────────────────────────────────────────────────

function _resolverReferencias() {
  _shellPanelStart = document.getElementById("shell-panel-start");
  _actionBar       = document.getElementById("main-action-bar");
  _panelCapas      = document.getElementById("panel-capas");
  _actionCapas     = document.getElementById("action-capas");
}

function _registrarListeners() {
  _actionCapas.addEventListener("click", () => _togglePanel("panel-capas", _actionCapas));
}

function _togglePanel(panelId, actionEl) {
  const panel = document.getElementById(panelId);
  if (!panel) return;

  const estaAbierto = !panel.closed;

  _cerrarTodosLosPaneles();

  if (estaAbierto) {
    if (_shellPanelStart) _shellPanelStart.collapsed = true;
    return;
  }

  if (_shellPanelStart) _shellPanelStart.collapsed = false;
  panel.closed = false;
  actionEl.active = true;
}

function _cerrarTodosLosPaneles() {
  document.querySelectorAll("calcite-panel[id]").forEach(p => {
    p.closed = true;
  });
  document.querySelectorAll("calcite-action[data-panel]").forEach(a => {
    a.active = false;
  });
}