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
 * Este archivo solo importa ui/loadingOverlay.js, normalizarDeployment.js y
 * validarDeployment.js, que no dependen de deployment.js: así este módulo
 * no puede romperse por el motivo que vigila.
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
import { validarDeployment } from "../config/validarDeployment.js";

/**
 * Muestra el banner #app-error.
 * @param {string}   mensaje  - frase principal
 * @param {string[]} detalles - lista opcional (p. ej. todos los errores de
 *   validación), pintada como <ul> para que se lea de un vistazo.
 */
function mostrarErrorArranque(mensaje, detalles = []) {
  // Se retira el splash para que el banner sea visible (mismo criterio que
  // el catch de main.js: el splash lo taparía por z-index).
  splash.ocultar();
  const errEl = document.getElementById("app-error");
  if (!errEl) return;

  // textContent (no innerHTML): los mensajes incluyen valores de la
  // configuración y no deben interpretarse como HTML.
  const titulo = document.createElement("p");
  titulo.textContent = mensaje;
  errEl.replaceChildren(titulo);

  if (detalles.length > 0) {
    const lista = document.createElement("ul");
    detalles.forEach(texto => {
      const li = document.createElement("li");
      li.textContent = texto;
      lista.appendChild(li);
    });
    errEl.appendChild(lista);
  }
  errEl.classList.remove("hidden");
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
      "La línea exacta aparece en la consola del navegador.",
      [`Detalle: ${err.name}: ${err.message}`]
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

  // 3b. Validar (M-01, pieza 2). Con errores la app NO arranca: arrancar con
  // una configuración inválida daría fallos más tarde y lejos de su causa.
  let resultado;
  try {
    resultado = validarDeployment(deploymentNormalizado);
  } catch (err) {
    // Un fallo del propio validador no debe dejar la página en blanco.
    console.error("[bootstrap] Error inesperado al validar la configuración:", err);
    mostrarErrorArranque("Error inesperado al validar config/deployment.js. Detalle en la consola.");
    return;
  }
  resultado.avisos.forEach(a => console.warn(`[validarDeployment] ${a}`));
  if (resultado.errores.length > 0) {
    resultado.errores.forEach(e => console.error(`[validarDeployment] ${e}`));
    mostrarErrorArranque(
      `config/deployment.js tiene ${resultado.errores.length} error(es) de configuración:`,
      resultado.errores
    );
    return;
  }

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