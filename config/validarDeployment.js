/**
 * config/validarDeployment.js
 *
 * Valida la configuración del cliente (DEPLOYMENT) ANTES de arrancar la app.
 * M-01, piezas 2 y 3.
 *
 * ── CONTRATO ─────────────────────────────────────────────────────────────
 *   validarDeployment(deployment) → { errores: string[], avisos: string[] }
 *
 *   errores → la configuración no es utilizable; bootstrap.js NO arranca la
 *             app y muestra la lista completa en #app-error.
 *   avisos  → la app funciona, pero algo es mejorable; van a console.warn.
 *
 * ── POR QUÉ ES UNA FUNCIÓN PURA Y SÍNCRONA ──────────────────────────────
 * No hace peticiones de red ni toca el DOM: recibe un objeto y devuelve
 * otro. Así se puede probar con configuraciones falsas (M-10) y no depende
 * del servidor. Lo que exige red (que exista municipios_<x>.json o que un
 * código INE exista en los datos) lo comprueba territorioResolver.js, que
 * es quien ya carga esos archivos (SRP).
 *
 * ── POR QUÉ DEVUELVE TODOS LOS ERRORES Y NO SOLO EL PRIMERO ─────────────
 * Quien despliega corrige la configuración de una vez en lugar de recargar
 * la app por cada error.
 *
 * ── POR QUÉ SE EJECUTA DESPUÉS DE normalizarDeployment ──────────────────
 * normalizarDeployment rellena valores por defecto (idiomas, idioma_defecto).
 * Validar el resultado normalizado evita marcar como error lo que ya tiene
 * un valor por defecto documentado.
 */

import { resolverTipoAmbito, TIPO_AMBITO } from "./tipoAmbito.js";
// Fuente única de los idiomas que la app sabe cargar: evita duplicar la lista.
import { IDIOMAS_SOPORTADOS } from "../utils/i18nManager.js";

const MODOS_VALIDOS              = ["demo", "production"];
const AMBITOS_NO_IMPLEMENTADOS   = ["comarca", "espana"];
const RE_CODIGO_ENTIDAD          = /^\d{2}$/;  // código INE de provincia o CCAA
const RE_CODIGO_MUNICIPIO        = /^\d{5}$/;  // código INE de municipio

/**
 * @param {Object} deployment - DEPLOYMENT ya normalizado
 * @returns {{ errores: string[], avisos: string[] }}
 */
export function validarDeployment(deployment) {
  const errores = [];
  const avisos  = [];

  _validarMode(deployment, errores);
  const tipo = _validarAmbito(deployment, errores);
  if (tipo === TIPO_AMBITO.MONOMUNICIPAL)  _validarMonomunicipal(deployment, errores);
  if (tipo === TIPO_AMBITO.SUPRAMUNICIPAL) _validarSupramunicipal(deployment, errores);
  _validarIdiomas(deployment, errores);
  _validarHerramientas(deployment, errores);
  _validarBranding(deployment, avisos);

  return { errores, avisos };
}

// ─── Reglas ──────────────────────────────────────────────────────────────

function _validarMode(d, errores) {
  // Sin valor por defecto a propósito (3DECISIONS 27.10.26): que la instancia
  // sea demo o producción debe constar en el propio archivo.
  if (!MODOS_VALIDOS.includes(d.mode)) {
    errores.push(
      `mode: ${_mostrar(d.mode)} no es válido. Usa "demo" o "production".`
    );
  }
}

/** Devuelve el tipo de ámbito, o null si no se puede determinar. */
function _validarAmbito(d, errores) {
  let tipo;
  try {
    // Se reutiliza la regla de tipoAmbito.js en lugar de repetirla (DRY).
    tipo = resolverTipoAmbito(d);
  } catch {
    errores.push(
      `ambitoTerritorial: ${_mostrar(d.ambitoTerritorial)} no es válido. ` +
      `Usa "municipio", "provincia" o "ccaa" (o quita el campo para ámbito municipal).`
    );
    return null;
  }
  if (AMBITOS_NO_IMPLEMENTADOS.includes(d.ambitoTerritorial)) {
    errores.push(
      `ambitoTerritorial: "${d.ambitoTerritorial}" todavía no está implementado.`
    );
    return null;
  }
  return tipo;
}

function _validarMonomunicipal(d, errores) {
  if (d.codigoEntidad != null) {
    errores.push(
      "codigoEntidad solo se usa con ambitoTerritorial \"provincia\" o \"ccaa\". " +
      "Quítalo o define el ámbito."
    );
  }
  if (!Array.isArray(d.municipios)) {
    errores.push(
      "municipios: falta o no es una lista. Ejemplo: municipios: [\"31201\"]."
    );
    return;
  }
  const invalidos = d.municipios.filter(c => typeof c !== "string" || !RE_CODIGO_MUNICIPIO.test(c));
  if (invalidos.length > 0) {
    errores.push(
      `municipios: códigos no válidos ${_mostrar(invalidos)}. ` +
      `Cada código INE de municipio son 5 dígitos entre comillas (ej. "31201").`
    );
  }
  // Pieza 3: en producción el ámbito monomunicipal sirve exactamente un
  // municipio (3DECISIONS 27.10.26). Antes era un aviso; ahora es error.
  if (d.mode === "production" && d.municipios.length !== 1) {
    errores.push(
      `municipios: en producción debe haber exactamente un municipio ` +
      `(hay ${d.municipios.length}). Varios, o la lista vacía, solo se admiten con mode: "demo".`
    );
  }
}

function _validarSupramunicipal(d, errores) {
  if (d.codigoEntidad == null || d.codigoEntidad === "") {
    errores.push(
      `codigoEntidad: obligatorio con ambitoTerritorial "${d.ambitoTerritorial}" ` +
      `(código INE de 2 dígitos, ej. "15").`
    );
  } else if (typeof d.codigoEntidad !== "string" || !RE_CODIGO_ENTIDAD.test(d.codigoEntidad)) {
    errores.push(
      `codigoEntidad: ${_mostrar(d.codigoEntidad)} no es válido. ` +
      `Debe ser un código INE de 2 dígitos entre comillas (ej. "15", "48").`
    );
  }
  if (d.municipios != null) {
    errores.push(
      "municipios no se combina con ambitoTerritorial \"provincia\"/\"ccaa\": " +
      "los municipios salen del territorio completo. Quita el campo."
    );
  }
}

function _validarIdiomas(d, errores) {
  if (!Array.isArray(d.idiomas) || d.idiomas.length === 0) {
    errores.push("idiomas: debe ser una lista con al menos un idioma. Ejemplo: [\"es\", \"en\"].");
    return;
  }
  const noSoportados = d.idiomas.filter(l => !IDIOMAS_SOPORTADOS.includes(l));
  if (noSoportados.length > 0) {
    errores.push(
      `idiomas: ${_mostrar(noSoportados)} no soportados. ` +
      `Disponibles: ${IDIOMAS_SOPORTADOS.join(", ")}.`
    );
  }
  if (!d.idiomas.includes(d.idioma_defecto)) {
    errores.push(
      `idioma_defecto: ${_mostrar(d.idioma_defecto)} no está en idiomas ${_mostrar(d.idiomas)}.`
    );
  }
}

function _validarHerramientas(d, errores) {
  // Ausente = sin herramientas (el panel se oculta, 3DECISIONS 02.11.26).
  if (d.herramientas === undefined) return;
  if (!Array.isArray(d.herramientas)) {
    errores.push(
      `herramientas: debe ser una lista (o no aparecer). Recibido: ${_mostrar(d.herramientas)}.`
    );
    return;
  }

  const idsVistos = new Set();
  d.herramientas.forEach((h, i) => {
    const ref = `herramientas[${i}]${h?.id ? ` ("${h.id}")` : ""}`;
    if (!h || typeof h !== "object") {
      errores.push(`${ref}: debe ser un objeto.`);
      return;
    }
    if (typeof h.id !== "string" || h.id === "") {
      errores.push(`${ref}: falta "id".`);
    } else if (idsVistos.has(h.id)) {
      errores.push(`${ref}: "id" repetido.`);
    } else {
      idsVistos.add(h.id);
    }
    if (typeof h.icono !== "string" || h.icono === "") {
      errores.push(`${ref}: falta "icono".`);
    }
    if (typeof h.habilitada !== "boolean") {
      errores.push(`${ref}: "habilitada" debe ser true o false.`);
    }

    // Exactamente una forma de declarar el widget (ver toolPanel.js):
    //   componente:  "tag" (instancia compartida) | null (acción sin widget)
    //   componentes: { "2D": "tag", "3D": "tag" } (widgets distintos por vista)
    const tieneComponente  = "componente" in h;
    const tieneComponentes = "componentes" in h;
    if (tieneComponente === tieneComponentes) {
      errores.push(`${ref}: declara "componente" o "componentes", uno de los dos.`);
    } else if (tieneComponente && h.componente !== null && typeof h.componente !== "string") {
      errores.push(`${ref}: "componente" debe ser el nombre de un Web Component o null.`);
    } else if (tieneComponentes &&
               (typeof h.componentes?.["2D"] !== "string" || typeof h.componentes?.["3D"] !== "string")) {
      errores.push(`${ref}: "componentes" necesita las claves "2D" y "3D".`);
    }
  });
}

function _validarBranding(d, avisos) {
  if (d.branding && "logo_cliente" in d.branding) {
    avisos.push(
      "branding.logo_cliente ya no se usa: el logo de la entidad se resuelve " +
      "por código en assets/logos/. Puedes quitar el campo."
    );
  }
}

// ─── Utilidades ──────────────────────────────────────────────────────────

/** Representación legible de un valor en los mensajes (undefined incluido). */
function _mostrar(valor) {
  return valor === undefined ? "(ausente)" : JSON.stringify(valor);
}
