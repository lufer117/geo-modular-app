"""
tools/lib/protocolo.py — reconocer qué protocolo es una fuente.

Responsabilidad única: a partir de la URL o de la raíz del XML devuelto,
decir qué protocolo es, usando solo los valores de listas > protocolo
(WMS, WMTS, WFS, WCS, XYZ, MVT, ATOM, API...). Nunca texto libre: esa es
la causa raíz de M-18 (28 variantes de "tipo" en el v1).

Dos fuentes de evidencia, en este orden:
  1. La URL: plantillas de teselas ({z}/{x}/{y}, {-y}, .pbf) o feeds .atom.
  2. La raíz del XML de capabilities, que es la autodescripción del
     servicio y por tanto la evidencia más fiable para OGC.
La URL de un OGC solo da una PISTA (la ruta contiene "wfs"): sirve para
probar primero el protocolo más probable, no para decidir.
"""

from __future__ import annotations

import re

# Variables de plantilla de teselas que el inspector sabe sustituir.
_VARIABLES_TESELA = {"{z}", "{x}", "{y}", "{-y}"}

# Orden en que se prueban los capabilities OGC cuando la URL no da pista.
# WMS primero: es el protocolo mayoritario del inventario (67 de 117).
ORDEN_PRUEBA_OGC = ["WMS", "WFS", "WMTS", "WCS"]

ROL_POR_PROTOCOLO = {
    # Valores por defecto de DISENO_CATALOGO.md §4. Hay WMTS temáticos:
    # ahí decide la persona en la columna rol (vacío = acepta esto).
    "WMS": "tematica", "WFS": "tematica", "FEATURE": "tematica",
    "GEOJSON": "tematica", "ArcGIS_REST": "tematica",
    "XYZ": "mapa_base", "WMTS": "mapa_base", "MVT": "mapa_base",
    "ATOM": "descarga", "WCS": "descarga",
    "API": "datos",
}


def motivo_no_inspeccionable(url: str) -> str | None:
    """
    Devuelve el motivo si la "URL" no se puede pedir tal cual (plantilla
    con parámetros que el inspector no conoce, clave de API, texto
    descriptivo), o None si se puede inspeccionar.
    Principio: no inventar valores para {style}, {s}, ?apikey=... — una
    sugerencia inventada es peor que "no inspeccionable".
    """
    if not url or not url.strip():
        return "sin_url"
    u = url.strip()
    if " " in u or "\n" in u:
        return "texto_no_url: contiene espacios"
    # Las variables se miran antes que el dominio: en "https://{s}.basemaps..."
    # el host es en sí una plantilla, y el motivo útil es ese.
    variables = set(re.findall(r"\{[^}]*\}", u))
    desconocidas = variables - _VARIABLES_TESELA
    if desconocidas:
        return f"plantilla_url: contiene {', '.join(sorted(desconocidas))}"
    if not re.match(r"^(https?://)?[\w.-]+\.[a-z]{2,}", u, re.IGNORECASE):
        return "texto_no_url: no empieza por un dominio"
    if "[" in u or "..." in u:
        return "plantilla_url: parámetros sin concretar"
    if re.search(r"[?&](api_?key|key|token|access_token)=", u, re.IGNORECASE):
        return "requiere_clave: la URL lleva una clave de API"
    return None


def detectar_por_url(url: str) -> str | None:
    """Protocolos que la URL decide por sí sola (no tienen capabilities)."""
    u = url.lower()
    if {"{z}", "{x}"} <= set(re.findall(r"\{[^}]*\}", u)):
        return "MVT" if ".pbf" in u or ".mvt" in u else "XYZ"
    if u.split("?")[0].endswith(".atom") or u.split("?")[0].endswith(".atom.xml"):
        return "ATOM"
    return None


def protocolo_del_id(id_estable: str) -> str | None:
    """Protocolo OGC con el que termina el id (ign-x-wfs → WFS), o None."""
    sufijo = id_estable.rsplit("-", 1)[-1].upper()
    return sufijo if sufijo in ORDEN_PRUEBA_OGC else None


def pista_ogc_por_url(url: str, declarado: str | None = None) -> list[str]:
    """
    Orden de prueba de capabilities. Prioridad:
      1. SERVICE=... en la propia URL.
      2. El protocolo que declara el id (decisión de la persona). Necesario
         porque un mismo endpoint puede servir varios protocolos: GeoServer
         elige por el parámetro service=, no por la ruta (caso INE,
         .../WMS_INE_SECCIONES_G01/wms responde también como WFS). Sin esto
         el inspector se quedaba con el primero que respondiera.
      3. La ruta de la URL ("wmts" antes que "wms" porque lo contiene).
    El inspector verifica la intención; si el declarado no responde, prueba
    los demás y el aviso del libro marca la discrepancia con razón.
    """
    u = url.lower()
    m = re.search(r"[?&]service=(wms|wmts|wfs|wcs)", u)
    if m:
        primero = m.group(1).upper()
    elif declarado in ORDEN_PRUEBA_OGC:
        primero = declarado
    elif "wmts" in u:
        primero = "WMTS"
    elif "wfs" in u:
        primero = "WFS"
    elif "wcs" in u:
        primero = "WCS"
    elif "wms" in u:
        primero = "WMS"
    else:
        return list(ORDEN_PRUEBA_OGC)
    return [primero] + [p for p in ORDEN_PRUEBA_OGC if p != primero]


def detectar_por_raiz(root) -> str | None:
    """
    Protocolo según el elemento raíz del XML. Se compara el nombre local
    (sin namespace) y, cuando es ambiguo ("Capabilities" lo usan WMTS y
    WCS 2.0), el namespace.
    """
    tag = root.tag
    ns = tag[1:].split("}")[0].lower() if tag.startswith("{") else ""
    local = tag.split("}")[-1]

    if local in ("WMS_Capabilities", "WMT_MS_Capabilities"):
        return "WMS"
    if local == "WFS_Capabilities":
        return "WFS"
    if local == "Capabilities":
        if "wmts" in ns:
            return "WMTS"
        if "wcs" in ns:
            return "WCS"
    if local == "WCS_Capabilities":
        return "WCS"
    if local == "feed" and "atom" in ns:
        return "ATOM"
    return None


def rol_sugerido(protocolo: str | None) -> str:
    return ROL_POR_PROTOCOLO.get(protocolo or "", "")
