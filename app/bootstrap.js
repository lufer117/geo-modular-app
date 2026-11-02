/**
 * app/bootstrap.js
 *
 * Punto de entrada real de la app. Única responsabilidad: comprobar que la
 * configuración del cliente carga ANTES de arrancar la app.
 *
 * ── POR QUÉ EXISTE ──────────────────────────────────────────────────────
 * main.js importaba deployment.js de forma estática. Los imports estáticos se
 * resuelven antes de ejecutar nada: si deployment.js falta o tiene un error
 * de sintaxis, main.js no llega a ejecutarse y el banner #app-error nunca
 * aparece. Con import() dinámico dentro de try/catch el fallo es capturable.
 *
 * Este archivo solo importa ui/loadingOverlay.js y normalizarDeployment.js,
 * que no dependen de deployment.js: así este módulo no puede romperse por
 * el motivo que vigila.
 *
 * Es el ÚNICO módulo que conoce config/deployment.js: el resto recibe la
 * configuración por parámetro (M-23), lo que deja intercambiable su origen.
 *
 * ── POR QUÉ EL MENSAJE VA EN ESPAÑOL FIJO, SIN i18n ─────────────────────
 * Va dirigido a quien despliega, no al usuario final, y i18nManager depende
 * de la configuración, justo lo que puede estar roto.
 */
import * as splash from "../ui/loadingOverlay.js";
import { normalizarDeployment } from "../config/normalizarDeployment.js";

function mostrarErrorArranque(mensaje) {
  // Se retira el splash para que el banner sea visible (mismo criterio que
  // el catch de main.js: el splash lo taparía por z-index).
  splash.ocultar();
  const errEl = document.getElementById("app-error");
  if (errEl) {
    errEl.textContent = mensaje;
    errEl.classList.remove("hidden");
  }
}

async function arrancar() {
  // 1. Cargar la configuración del cliente.
  let modulo;
  try {
    modulo = await import("../config/deployment.js");
  } catch (err) {
    console.error("[bootstrap] No se pudo cargar config/deployment.js:", err);
    mostrarErrorArranque(
      "No se pudo cargar la configuración (config/deployment.js). " +
      "Comprueba que el archivo existe (cópialo desde deploymentTemplate.js), " +
      "que no tiene errores de sintaxis y que exporta DEPLOYMENT. " +
      "Detalle en la consola del navegador."
    );
    return;
  }

  // 2. Comprobar que exporta lo esperado.
  const deployment = modulo.DEPLOYMENT;
  if (!deployment || typeof deployment !== "object") {
    console.error("[bootstrap] deployment.js no exporta un objeto DEPLOYMENT válido:", modulo);
    mostrarErrorArranque(
      "config/deployment.js no exporta un objeto DEPLOYMENT. " +
      "Revisa que termine con: export const DEPLOYMENT = clienteActivo;"
    );
    return;
  }

  // 3. Rellenar valores por defecto. Devuelve una copia; el original no se toca.
  const deploymentNormalizado = normalizarDeployment(deployment);

  // 4. Arrancar la app, entregándole la configuración.
  try {
    const { main } = await import("./main.js");
    await main(deploymentNormalizado);
  } catch (err) {
    // Aquí solo llegan fallos al cargar el grafo de módulos de main.js
    // (p. ej. un archivo con 404); los errores de ejecución los gestiona
    // el try/catch propio de main().
    console.error("[bootstrap] Fallo al cargar los módulos de la aplicación:", err);
    mostrarErrorArranque(
      "No se pudieron cargar los módulos de la aplicación. " +
      "Revisa la pestaña Red/Consola del navegador para ver qué archivo falla."
    );
  }
}

// Un <script type="module"> se ejecuta con el DOM ya parseado: se puede
// arrancar directamente, sin esperar a DOMContentLoaded.
arrancar();