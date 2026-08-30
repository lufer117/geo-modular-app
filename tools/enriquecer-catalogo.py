"""
enriquecer-catalogo.py

Script de resolución final: catalogo-capas-ne.json → catalogo-capas.json

# ═══════════════════════════════════════════════════════
# CÓMO CORRER ESTE SCRIPT (leer antes de ejecutar)
# ═══════════════════════════════════════════════════════
#
# PASO 1 — activar el entorno virtual (si no está activo ya):
#     .\.venv\Scripts\Activate.ps1
#     (el prompt debe mostrar (.venv) al inicio)
#
# PASO 2 — exportar el bundle de certificados SSL, EN LA MISMA VENTANA
#          de PowerShell donde vas a correr el script. Esto es obligatorio
#          mientras varios servicios (wms.mapama.gob.es y dominios
#          asociados) usen la CA intermedia FNMT que falta en certifi —
#          ver tools/scratch/fix_certificado_fnmt.py para el detalle.
#          Sin este paso, ~24 capas fallan con SSLCertVerificationError
#          aunque el servicio esté perfectamente sano.
#
#     $env:REQUESTS_CA_BUNDLE = "C:\Dev\geo-app\tools\scratch\cacert_fnmt.pem"
#
#     (ajusta la ruta si tu repo está en otra carpeta. Esta variable solo
#     dura mientras esa ventana de PowerShell esté abierta — si la cierras
#     y abres una nueva, hay que exportarla de nuevo antes de correr el
#     script otra vez. Si el archivo cacert_fnmt.pem todavía no existe,
#     generarlo primero con: python tools\scratch\fix_certificado_fnmt.py)
#
# PASO 3 — correr el script apuntando al -ne.json real:
#     python tools\enriquecer-catalogo.py data\catalogo\catalogo-capas-ne.json
#
#     Tarda varios minutos (recorre ~94 candidatas contra sus servicios
#     reales, con reintentos y backoff). Es esperado, no interrumpir.
#
# PASO 4 — revisar antes de dar el catálogo por bueno:
#     - data\catalogo\catalogo-capas.json          → catálogo final generado
#     - data\catalogo\informe-enriquecimiento.txt  → detalle completo por capa
#
# ═══════════════════════════════════════════════════════

Toma las capas marcadas incluir_en_catalogo_final=true en el catálogo de
referencia, consulta el GetCapabilities real de cada servicio, y deriva
por reglas de preferencia (nunca inventando) los campos que el propio
servicio declara: formatos_salida/formato_consumo, srsname,
featureInfoFormat, sublayers (id/title/legendUrl).

Todo lo que no se puede resolver por ninguna vía queda marcado
"pendiente_curacion" en el JSON de salida y detallado en el informe —
nunca se omite ni se completa en silencio.

USO:
    python enriquecer-catalogo.py                    # usa catalogo-capas-ne.json
    python enriquecer-catalogo.py mi-catalogo-ne.json # archivo personalizado
    python enriquecer-catalogo.py --solo-fallidas     # ver más abajo

    --solo-fallidas:
        Reprocesa SOLO las candidatas que en la última ejecución (leída de
        catalogo-capas.json, si existe) NO quedaron incluidas — es decir,
        cualquier capa que en el informe anterior salió con estado
        excluida_* o que es nueva desde entonces. Las capas que ya estaban
        ok/ok_con_pendientes se reutilizan tal cual, sin volver a golpear
        el servicio. Pensado únicamente para iterar rápido durante
        depuración (ej. ajustando un capabilities_url mal transcrito o
        corrigiendo certificados SSL) — NO reemplaza una corrida completa
        antes de dar el catálogo por definitivo: el catálogo final debe
        reflejar el estado real y actual de TODOS los servicios, no un
        acumulado de "lo que alguna vez funcionó" (una capa que hoy pasa
        podría fallar mañana sin que nadie se entere si nunca se
        re-verifica). Por eso el comportamiento por defecto, sin la
        bandera, sigue siendo la corrida completa sobre las 94+
        candidatas.

SALIDA:
    catalogo-capas.json          → catálogo activo, listo para LocalJsonAdapter
    informe-enriquecimiento.txt  → resumen de estados, discrepancias y diff

REQUISITOS:
    pip install requests

ESTADOS POSIBLES por capa (campo _resolucion.estado):
    ok                      → todos los campos derivables se resolvieron
    ok_con_pendientes       → se incluyó, pero algún campo quedó pendiente_curacion
    excluida_error_red      → GetCapabilities no respondió — no entra al catálogo final
    excluida_xml_invalido   → respuesta no parseable — no entra al catálogo final
    excluida_discrepancia   → disponibilidad_municipal del Excel no coincide con la
                               heurística del script — no entra hasta resolución manual
    reutilizada_sin_red     → (solo con --solo-fallidas) ya estaba ok en la corrida
                               anterior, no se volvió a consultar el servicio

# ═══════════════════════════════════════════════════════
# ETAPA 2 — enriquecer-catalogo.py en la raiz del proyecto  
# ═══════════════════════════════════════════════════════

# Requisito previo: catalogo-capas-ne.json ya debe existir en data\catalogo\
# (generado por migrar-catalogo.py, ver paso anterior).

# 1. Confirmar que el entorno virtual sigue activo
#    (el prompt debe mostrar (.venv) al inicio; si no, repetir:
#    .\.venv\Scripts\Activate.ps1)

# 2. Ejecutar enriquecer-catalogo.py, apuntando al -ne.json de data\catalogo\
#    Genera catalogo-capas.json e informe-enriquecimiento.txt en esa misma carpeta.
python tools\enriquecer-catalogo.py data\catalogo\catalogo-capas-ne.json

# 2b. Durante depuración iterativa (ajustando capabilities_url, certificados,
#     etc.), para no reprocesar TODAS las candidatas cada vez:
python tools\enriquecer-catalogo.py data\catalogo\catalogo-capas-ne.json --solo-fallidas

# 3. Revisar el resultado antes de promoverlo a producción:
#    - data\catalogo\catalogo-capas.json          → catálogo final generado
#    - data\catalogo\informe-enriquecimiento.txt  → detalle por capa:
#        ok / ok_con_pendientes / excluida_error_red / excluida_discrepancia
#
#    Cualquier capa con estado distinto de "ok" requiere revisión manual
#    antes de dar el catálogo por válido (ver informe para el motivo exacto).
#
#    IMPORTANTE: antes de dar el catálogo por DEFINITIVO (no solo durante
#    depuración), correr SIEMPRE sin --solo-fallidas al menos una vez, para
#    confirmar que las capas que ya pasaban siguen pasando hoy.

# ═══════════════════════════════════════════════════════
# CORRECCIÓN 30/08/2026 — heuristica_disponibilidad_base()
# ═══════════════════════════════════════════════════════
# Hallazgo real: la función original solo contemplaba WFS como tipo con
# auditoría diferida a red ("return None"); cualquier otro tipo caía al
# default {"BBOX"}. Esto es correcto para WMS/WMTS/XYZ (protocolos que
# físicamente solo permiten filtrado por bbox), pero es un vacío de
# cobertura para ATOM y API REST: ambos SÍ pueden filtrar por código INE
# (confirmado en catálogo: Edificaciones/Parcelas Catastrales vía ATOM
# declaran FILTRABLE/ATOM; AEMET/INE vía API REST declaran API). Sin esta
# corrección, esas capas P0-MVP se marcaban excluida_discrepancia por un
# hueco de diseño, no porque el servicio real fallara. Ver también el
# tratamiento ya existente de CONDICIONAL, documentado con el mismo
# patrón de vacío de cobertura en resolver_condicional().

# ═══════════════════════════════════════════════════════
# HALLAZGO 30/08/2026 — SSL CERTIFICATE_VERIFY_FAILED contra mapama.gob.es
# ═══════════════════════════════════════════════════════
# Confirmado con diagnóstico real: wms.mapama.gob.es (y dominios
# asociados .miteco.gob.es/.mapama.es) usan un certificado emitido por
# FNMT-RCM / AC Componentes Informáticos, cuya CA intermedia NO está
# incluida en el bundle público de Mozilla que usa certifi/requests —
# aunque Windows, navegadores y QGIS sí la resuelven automáticamente vía
# AIA (Authority Information Access). Esto NO es un fallo del servicio:
# el mismo GetCapabilities que falla en requests.get() carga sin problema
# en QGIS y en el navegador. Solución aplicada (fuera de este script, ver
# tools/scratch/fix_certificado_fnmt.py): generar un bundle de CA
# combinado (certifi + la CA FNMT faltante) y apuntar requests a él via
# la variable de entorno REQUESTS_CA_BUNDLE antes de correr este script.
# Este script no necesita ningún cambio de código para beneficiarse del
# fix — requests respeta REQUESTS_CA_BUNDLE automáticamente si está
# exportada en el entorno donde se ejecuta.
"""

import argparse
import sys
import json
import datetime
import time
import re
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse, urlencode, urlunparse, parse_qs

try:
    import requests
except ImportError:
    print("❌ Falta 'requests'. Instálala con: pip install requests")
    sys.exit(1)


# ─────────────────────────────────────────────
# CONFIGURACIÓN
# ─────────────────────────────────────────────
TIMEOUT_SEGUNDOS     = 15
ARCHIVO_ENTRADA      = "catalogo-capas-ne.json"
ARCHIVO_SALIDA       = "catalogo-capas.json"
ARCHIVO_INFORME      = "informe-enriquecimiento.txt"

# Preferencia de SRS: se toma el primero que el servicio también soporte.
PREFERENCIA_SRS = ["EPSG:4326", "EPSG:3857"]


def extraer_srs_wfs(root: ET.Element) -> str | None:
    """
    Hallazgo real (25/08/2026): layerInitializer.js SÍ usa config.srsname
    para capas WFS con disponibilidad_municipal=BBOX — decide si el bbox
    enviado al servidor se reproyecta a EPSG:3857 o va directo en 4326
    (ver aplicarBboxWfs()). La primera versión del script solo extraía
    srsname para WMS; esto dejaba las WFS sin ese dato, cayendo al
    default EPSG:4326 aunque el servicio real declare otro (confirmado:
    SIOSE trae EPSG:3857 en el catálogo activo actual).

    WFS declara el CRS por FeatureType via <DefaultSRS> (1.x) o
    <DefaultCRS> (2.0), como texto plano (ej. "urn:ogc:def:crs:EPSG::3857"
    o "EPSG:3857" según versión) — se aplica la misma preferencia que en
    WMS, tomando el primero de la lista de preferencia que aparezca.
    """
    declarados = set()
    for el in root.iter():
        tag_local = el.tag.split("}")[-1]
        if tag_local in ("DefaultSRS", "DefaultCRS") and el.text:
            texto = el.text.strip()
            match = re.search(r"(\d+)$", texto)
            if match:
                declarados.add(f"EPSG:{match.group(1)}")

    for preferido in PREFERENCIA_SRS:
        if preferido in declarados:
            return preferido
    return next(iter(declarados), None)

# Preferencia de formato de GetFeatureInfo.
PREFERENCIA_FEATURE_INFO_FORMAT = ["application/json", "text/html"]

NS = {
    "wms130": "http://www.opengis.net/wms",
    "ows":    "http://www.opengis.net/ows/1.1",
}

PARAMS_CAPABILITIES = {
    "WMS":  {"SERVICE": "WMS",  "REQUEST": "GetCapabilities"},
    "WMTS": {"SERVICE": "WMTS", "REQUEST": "GetCapabilities"},
    "WFS":  {"SERVICE": "WFS",  "REQUEST": "GetCapabilities"},
    "WCS":  {"SERVICE": "WCS",  "REQUEST": "GetCapabilities"},
}

# Esquema mínimo exigido para que una capa se escriba en catalogo-capas.json.
# Si falta cualquiera de estos campos tras la resolución, la capa cae en
# pendiente_curacion en vez de escribirse a medias (ver validar_esquema_minimo).
CAMPOS_OBLIGATORIOS = ["id", "title", "tipo", "url", "cobertura", "disponibilidad_municipal"]


# ─────────────────────────────────────────────
# CONSTRUCCIÓN DE URL DE CAPABILITIES
# ─────────────────────────────────────────────

def _normalizar_esquema(url: str) -> str:
    """
    Corrige URLs sin esquema declaradas a mano en el Excel (ej.
    "ovc.catastro.meh.es/..." en vez de "https://ovc.catastro.meh.es/...").
    Hallazgo real detectado al probar el script contra el Excel/-ne.json:
    varias filas de capabilities vienen sin protocolo — sin esta corrección
    requests.get() falla con "Invalid URL" antes de intentar la conexión.
    """
    if url and not url.startswith(("http://", "https://")):
        return f"https://{url}"
    return url


def construir_url_capabilities(capa: dict) -> str | None:
    caps_url = (capa.get("capabilities_url") or "").strip()
    if caps_url:
        return _normalizar_esquema(caps_url)

    tipo    = capa.get("tipo", "").upper()
    url_base = (capa.get("url") or "").strip()
    params  = PARAMS_CAPABILITIES.get(tipo)
    if not url_base or not params:
        return None

    url_base = _normalizar_esquema(url_base)
    parsed   = urlparse(url_base)
    existing = parse_qs(parsed.query)
    merged   = {k.upper(): v for k, v in existing.items()}
    merged.update(params)
    query = urlencode({k: v[0] if isinstance(v, list) else v for k, v in merged.items()})
    return urlunparse(parsed._replace(query=query))


HEADERS_PETICION = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    "Accept": "application/xml,text/xml,*/*",
}
# Nota: algunos servicios públicos (confirmado con Catastro,
# ovc.catastro.meh.es) bloquean peticiones que se identifican como
# scripts/bots mediante ConnectionResetError, incluso siendo un uso
# legítimo y de bajo volumen. Un User-Agent de navegador real no oculta
# el origen del script — solo evita el bloqueo automático agresivo que
# no distingue entre scraping masivo y una consulta puntual de
# GetCapabilities. Si aun así el servicio bloquea, ver reintento con
# backoff más abajo, y como último recurso, curación manual documentada.


def _es_service_exception(root: ET.Element) -> str | None:
    """
    Detecta si el XML descargado es un ServiceExceptionReport (WMS 1.1.1/1.3.0)
    en vez del GetCapabilities esperado. Hallazgo real (30/08/2026, Red Natura
    2000 / ENP, wms.mapama.gob.es/sig/Biodiversidad/*): el servidor devuelve
    HTTP 200 con un XML bien formado que es un reporte de error interno
    (confirmado: NullReferenceException en ConstruirServiceArcGISBaseUrl(),
    bug del backend .NET del proveedor, no de la petición del cliente).
    Como el XML es válido, fetch_xml() no lo detectaba como fallo — pasaba
    de largo y _localizar_capa_raiz() simplemente no encontraba Capability/
    Layer, dejando un pendiente_curacion genérico que no explica la causa
    real. Devuelve el mensaje de excepción si lo detecta, None si no aplica.
    """
    tag_local = root.tag.split("}")[-1]
    if tag_local != "ServiceExceptionReport":
        return None
    for el in root.iter():
        if el.tag.split("}")[-1] == "ServiceException":
            return (el.text or "").strip()[:200]
    return "ServiceExceptionReport sin detalle"


def fetch_xml(url: str, reintentos: int = 2) -> tuple[ET.Element | None, str]:
    ultimo_error = "error_red: sin intentos"
    for intento in range(reintentos + 1):
        try:
            resp = requests.get(url, timeout=TIMEOUT_SEGUNDOS, headers=HEADERS_PETICION)
            resp.raise_for_status()
            try:
                root = ET.fromstring(resp.content)
            except ET.ParseError as e:
                return None, f"xml_invalido: {str(e)[:80]}"

            excepcion = _es_service_exception(root)
            if excepcion is not None:
                return None, f"servicio_caido: {excepcion}"

            return root, "ok"
        except requests.exceptions.Timeout:
            ultimo_error = "error_red: timeout"
        except requests.exceptions.ConnectionError as e:
            ultimo_error = f"error_red: {str(e)[:80]}"
        except requests.exceptions.HTTPError:
            ultimo_error = f"error_red: HTTP {resp.status_code}"
        except Exception as e:
            ultimo_error = f"error_red: {str(e)[:80]}"

        if intento < reintentos:
            time.sleep(2 * (intento + 1))  # backoff simple: 2s, 4s...

    return None, ultimo_error


# ─────────────────────────────────────────────
# EXTRACCIÓN DE CAMPOS DESDE GetCapabilities (WMS)
# ─────────────────────────────────────────────
#
# Principio general aplicado en todo este bloque: EXTRAER, no construir.
# Cada función busca el elemento que el servicio ya declara en su XML y
# lo toma tal cual. Solo se aplica una regla de PREFERENCIA cuando el
# servicio ofrece varias opciones válidas (varios SRS, varios formatos).
# Si no hay nada que extraer, se devuelve None explícito — nunca se inventa
# un valor por defecto silencioso.

def _localizar_capa_raiz(root: ET.Element) -> ET.Element | None:
    ns = NS["wms130"]
    for nodo in [root.find(f".//{{{ns}}}Capability/{{{ns}}}Layer"),
                 root.find(".//Capability/Layer")]:
        if nodo is not None:
            return nodo
    return None


def extraer_srs_preferido(root: ET.Element, capa_raiz: ET.Element) -> str | None:
    """Nivel 1: extracción con preferencia. No construye nada."""
    ns = NS["wms130"]
    declarados = set()
    for tag in [f"{{{ns}}}CRS", "CRS", f"{{{ns}}}SRS", "SRS"]:
        for el in capa_raiz.findall(tag):
            if el.text:
                declarados.add(el.text.strip().upper())

    for preferido in PREFERENCIA_SRS:
        if preferido.upper() in declarados:
            return preferido

    return next(iter(declarados), None)  # lo que haya, si nada de la preferencia calza


def extraer_feature_info_format(root: ET.Element) -> str | None:
    """Nivel 1: extracción con preferencia sobre Capability/Request/GetFeatureInfo/Format."""
    ns = NS["wms130"]
    formatos = set()
    for tag in [f".//{{{ns}}}GetFeatureInfo/{{{ns}}}Format", ".//GetFeatureInfo/Format"]:
        for el in root.findall(tag):
            if el.text:
                formatos.add(el.text.strip())

    for preferido in PREFERENCIA_FEATURE_INFO_FORMAT:
        if preferido in formatos:
            return preferido

    return next(iter(formatos), None)


def extraer_legend_url(sublayer_el: ET.Element) -> tuple[str | None, str]:
    """
    Nivel 1: extracción directa de Style/LegendURL/OnlineResource (href tal cual).
    Nivel 2 (fallback): NO se resuelve aquí — requiere saber si el servicio
    anuncia GetLegendGraphic a nivel de Capability, lo hace resolver_legend_urls().
    Devuelve (url_o_None, motivo_si_no_hay).
    """
    ns = NS["wms130"]
    for tag in [f"{{{ns}}}Style", "Style"]:
        style_el = sublayer_el.find(tag)
        if style_el is None:
            continue
        for legend_tag in [f"{{{ns}}}LegendURL", "LegendURL"]:
            legend_el = style_el.find(legend_tag)
            if legend_el is None:
                continue
            for resource_tag in [f"{{{ns}}}OnlineResource", "OnlineResource"]:
                resource_el = legend_el.find(resource_tag)
                if resource_el is not None:
                    href = resource_el.get("{http://www.w3.org/1999/xlink}href") or resource_el.get("href")
                    if href:
                        return href, "ok"
    return None, "sin_legendurl_declarada_en_capa"


def _soporta_get_legend_graphic(root: ET.Element) -> bool:
    ns = NS["wms130"]
    return (root.find(f".//{{{ns}}}Request/{{{ns}}}GetLegendGraphic") is not None or
            root.find(".//Request/GetLegendGraphic") is not None)


def construir_legend_graphic_fallback(capa: dict, sublayer_name: str) -> str | None:
    """Nivel 2: fallback estándar GetLegendGraphic, solo si el servicio la anuncia."""
    url_base = (capa.get("url") or "").strip()
    if not url_base:
        return None
    parsed = urlparse(url_base)
    params = {
        "SERVICE": "WMS", "REQUEST": "GetLegendGraphic",
        "LAYER": sublayer_name, "FORMAT": "image/png",
    }
    query = urlencode(params)
    return urlunparse(parsed._replace(query=query))


def _find_seguro(elemento: ET.Element, *tags: str) -> ET.Element | None:
    """
    Busca el primer tag que exista, probando cada uno en orden.
    Reemplaza el patrón 'elemento.find(a) or elemento.find(b)', que es
    incorrecto en ElementTree: un elemento XML hoja (sin hijos) se evalúa
    como falso en un 'or' aunque sí exista y tenga texto — Python 3.12+
    lo marca con DeprecationWarning porque ese comportamiento cambiará a
    error en el futuro. Hallazgo real detectado al correr el script contra
    SIGPAC (ver prueba en carpeta local, 25/08/2026).
    """
    for tag in tags:
        el = elemento.find(tag)
        if el is not None:
            return el
    return None


PATRONES_SUBLAYER_AUXILIAR = ("TXT", "ELEMLIN", "EJES", "LIMITES", "TEXTOS")
# Hallazgo real (30/08/2026, catálogo Catastro): algunos WMS gubernamentales
# (confirmado en ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx)
# publican, junto a las capas temáticas reales (PARCELA, CONSTRU, MASA),
# sublayers puramente auxiliares de composición cartográfica: etiquetas de
# texto de esas mismas capas (TXTPARCELA, TXTCONSTRU, TXTMASA, TXTSUBPARCE)
# y elementos de apoyo gráfico (EJES, ELEMLIN, LIMITES, TEXTOS). El WMS no
# distingue esto en su GetCapabilities — todas llegan como <Layer> hijos
# al mismo nivel, sin ningún atributo que las marque como "auxiliares".
# Se detectan por patrón de nombre (heurística, no garantía absoluta) y se
# marcan con "auxiliar": true en vez de eliminarse del JSON — la capa NO
# se descarta silenciosamente, solo se señaliza para que layerTree.js
# decida en runtime si la oculta del árbol de selección o la trata como
# hija no-togglable de su capa temática asociada. Conservar el dato
# completo (en vez de excluirlo aquí) respeta el principio de este script:
# nunca omitir información que el servicio sí declara.


def _es_sublayer_auxiliar(sublayer_id: str) -> bool:
    id_upper = sublayer_id.upper()
    return any(patron in id_upper for patron in PATRONES_SUBLAYER_AUXILIAR)


# Diccionario global de nombres amigables por id técnico de sublayer.
# Hallazgo real (30/08/2026, Catastro): el WMS declara title == name para
# sus sublayers (ej. "CONSTRU" en vez de "Construcciones") — es el código
# técnico interno del servicio, no un nombre pensado para usuario final.
# Como estos códigos son estándar nacional (mismo WMS, mismos nombres en
# cualquier municipio de España que use Catastro), se declaran UNA VEZ
# aquí y se aplican como override sobre el title crudo del servicio, en
# vez de editar el JSON generado a mano — así el nombre amigable sobrevive
# a cualquier corrida futura del script sin mantenimiento repetido.
# Clave: id técnico tal cual lo declara el WMS (mayúsculas exactas).
# Ampliar esta tabla según se vayan curando más WMS con códigos crípticos.
NOMBRES_AMIGABLES_SUBLAYER = {
    # Catastro (ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx)
    "CONSTRU":  "Construcciones",
    "SUBPARCE": "Subparcelas",
    "PARCELA":  "Parcelas",
    "MASA":     "Manzanas",
}


def _title_amigable(sublayer_id: str, title_original: str) -> str:
    """
    Devuelve el nombre amigable curado si existe entrada en el diccionario
    para este id técnico; si no, devuelve el title tal cual lo declaró el
    servicio (nunca se inventa un nombre para códigos no catalogados).
    """
    return NOMBRES_AMIGABLES_SUBLAYER.get(sublayer_id.upper(), title_original)


def extraer_sublayers(root: ET.Element, capa: dict) -> list:
    ns = NS["wms130"]
    capa_raiz = _localizar_capa_raiz(root)
    if capa_raiz is None:
        return []

    soporta_glg = _soporta_get_legend_graphic(root)
    sublayers = []

    ns_prefix = f"{{{ns}}}" if ns else ""
    for sub_el in capa_raiz.findall(f"{ns_prefix}Layer") or capa_raiz.findall("Layer"):
        name_el  = _find_seguro(sub_el, f"{ns_prefix}Name", "Name")
        title_el = _find_seguro(sub_el, f"{ns_prefix}Title", "Title")
        if name_el is None or not name_el.text:
            continue

        name  = name_el.text.strip()
        title = (title_el.text or name).strip() if title_el is not None else name
        title = _title_amigable(name, title)

        legend_url, motivo = extraer_legend_url(sub_el)
        if legend_url is None and soporta_glg:
            legend_url = construir_legend_graphic_fallback(capa, name)
            motivo = "ok_fallback_getlegendgraphic"

        sublayers.append({
            "id":        name,
            "title":     title,
            "visible":   False,   # constante de la app, no derivado
            "auxiliar":  _es_sublayer_auxiliar(name),
            "legendUrl": legend_url,
            "_legend_motivo": motivo if legend_url is None else None,
        })

    return sublayers


# ─────────────────────────────────────────────
# FORMATOS DE SALIDA (formatos_salida / formato_consumo)
# ─────────────────────────────────────────────

PREFERENCIA_FORMATO_WMS = ["image/png", "image/jpeg"]


def extraer_formatos_wms(root: ET.Element) -> list:
    ns = NS["wms130"]
    formatos = set()
    for tag in [f".//{{{ns}}}GetMap/{{{ns}}}Format", ".//GetMap/Format"]:
        for el in root.findall(tag):
            if el.text:
                formatos.add(el.text.strip())
    return sorted(formatos)


def extraer_formatos_wfs(root: ET.Element) -> list:
    """
    Ver docstring anterior sobre los 3 patrones posibles. CORRECCIÓN
    (hallazgo real, prueba 25/08/2026 contra SIOSE/Redes Geodésicas/INE):
    la primera versión buscaba cualquier <Value> en todo el documento,
    sin verificar de qué <Parameter> depende — WFS 2.0 declara <Value>
    para MUCHOS parámetros distintos (outputFormat, sí, pero también CRS
    soportados, resultType, versiones...), todos con la misma etiqueta.
    Sin acotar al <Parameter name="outputFormat">, el resultado se
    contaminaba con códigos EPSG, nombres de sección del propio XML
    (OperationsMetadata, ServiceIdentification) y valores de resultType
    (hits, local, none). Ahora se exige que el <Value> cuelgue de un
    <Parameter> cuyo atributo name sea "outputFormat" (insensible a
    mayúsculas), evitando capturar valores de otros parámetros.
    """
    formatos = set()
    TAGS_FORMATO_VACIO = {
        "GML2", "GML3", "GML32", "GEOJSON", "JSON", "SHAPE-ZIP", "CSV", "KML",
    }

    for parametro in root.iter():
        tag_local = parametro.tag.split("}")[-1]
        if tag_local != "Parameter":
            continue
        nombre_param = (parametro.get("name") or "").strip().lower()
        if nombre_param != "outputformat":
            continue
        for hijo in parametro.iter():
            hijo_tag = hijo.tag.split("}")[-1]
            if hijo_tag == "Value" and hijo.text and hijo.text.strip():
                formatos.add(hijo.text.strip())

    # Patrones (2) y (3), que no dependen de Parameter/outputFormat:
    for el in root.iter():
        tag_local = el.tag.split("}")[-1]
        if tag_local == "Format" and el.text and el.text.strip():
            formatos.add(el.text.strip())
        elif tag_local.upper() in TAGS_FORMATO_VACIO:
            formatos.add(tag_local)

    return sorted(formatos)


def resolver_formatos(tipo: str, root: ET.Element) -> tuple[list, str | None]:
    """
    Devuelve (formatos_salida, formato_consumo).
    Para WFS: formato_consumo debe ser GeoJSON o la capa queda pendiente_curacion
    (WFSLayer del SDK v5 lo requiere — ver 3DECISIONS.md).
    """
    if tipo == "WMS":
        formatos = extraer_formatos_wms(root)
        # Preferencia: PNG antes que JPEG — JPEG no soporta transparencia,
        # generaría fondo opaco sobre el mapa base en un overlay (hallazgo
        # real: SIGPAC daba formato_consumo="image/jpeg" solo por venir
        # primero alfabéticamente entre ["image/jpeg","image/png"]).
        for preferido in PREFERENCIA_FORMATO_WMS:
            if preferido in formatos:
                return formatos, preferido
        return formatos, (formatos[0] if formatos else None)

    if tipo == "WFS":
        formatos = extraer_formatos_wfs(root)
        geojson_variantes = {"GeoJSON", "application/json", "json"}
        tiene_geojson = any(f in geojson_variantes or "json" in f.lower() for f in formatos)
        return formatos, ("GeoJSON" if tiene_geojson else None)

    return [], None


# ─────────────────────────────────────────────
# AUDITORÍA DE disponibilidad_municipal
# ─────────────────────────────────────────────

def heuristica_disponibilidad_base(tipo: str) -> set | None:
    """
    Conjunto plausible SIN consultar el servicio — válido para tipos donde
    el protocolo por sí solo ya decide: WMS/WMTS/XYZ nunca pueden filtrar
    por atributo del lado del servidor, así que solo BBOX es posible.
    Para WFS no hay nada que decidir aquí — la señal real requiere
    consultar el servicio (ver heuristica_disponibilidad_wfs).

    CORRECCIÓN 30/08/2026: ATOM y API REST tampoco tienen una heurística
    barata fiable. A diferencia de WMS/WMTS/XYZ, SÍ pueden filtrar por
    atributo del lado del servidor (confirmado en catálogo: Edificaciones
    y Parcelas Catastrales vía ATOM declaran FILTRABLE/ATOM porque el
    feed es filtrable por código INE; AEMET/INE vía API REST declaran API
    porque el endpoint se consulta directamente por municipio). Antes de
    esta corrección, cualquier valor no-BBOX para estos tipos se
    auditaba como discrepancia y la capa se descartaba — no porque el
    servicio real fallara, sino por un vacío de cobertura en esta
    heurística (mismo patrón de vacío ya documentado para CONDICIONAL en
    resolver_condicional()). No hay verificación de red barata posible
    para ATOM/API (no exponen GetCapabilities estándar), así que se
    acepta el valor declarado en el Excel sin auditar, en vez de forzarlo
    a coincidir con {"BBOX"}.
    """
    if tipo == "WFS":
        return None  # señal: requiere consulta real, no hay respuesta barata
    if tipo in ("ATOM", "API REST", "API"):
        return None  # señal: no auditable sin GetCapabilities estándar, se acepta el valor del Excel
    return {"BBOX"}


def heuristica_disponibilidad_wfs(root: ET.Element) -> set:
    """
    Conjunto plausible para WFS, ya con el capabilities real descargado.
    Si el servicio expone un atributo de tipo código INE, FILTRABLE/DIRECTA
    son plausibles. Si no se encuentra esa señal, el único valor plausible
    por defecto es BBOX — todo WFS soporta consulta espacial estándar,
    filtre o no por atributo (caso real: SIOSE y Corine, ver sus notas
    en el catálogo: "requiere gestión de BBOX por volumen de datos").
    """
    if verificar_atributo_ine(root) is True:
        return {"FILTRABLE", "DIRECTA"}
    return {"BBOX"}


def verificar_atributo_ine(root: ET.Element) -> bool | None:
    """
    Pista adicional (no determinante) para WFS: busca en el XML de
    capabilities un nombre de atributo que sugiera código INE filtrable
    (codigo_ine, cod_ine, ine_code...). Requiere DescribeFeatureType real
    para ser concluyente — esto es una aproximación sobre el propio
    GetCapabilities cuando lo declara inline. Devuelve None si no hay
    señal suficiente (ni confirma ni descarta).
    """
    patrones = ("codigo_ine", "cod_ine", "ine_code", "codine")
    texto_xml = ET.tostring(root, encoding="unicode").lower()
    if any(p in texto_xml for p in patrones):
        return True
    return None


def auditar_disponibilidad_base(capa: dict) -> tuple[bool | None, str, set | None]:
    """
    Auditoría SIN red. Devuelve (coincide, valor_excel, conjunto_o_None).
    coincide=None significa "no evaluable todavía" (caso WFS: requiere
    consultar el servicio primero, ver auditar_disponibilidad_wfs; caso
    ATOM/API REST: no auditable, se acepta el valor del Excel sin más —
    ver heuristica_disponibilidad_base).

    CONDICIONAL YA NO está exento (corrección: es una restricción de
    alcance geográfico, no un valor técnico de acceso — el switch de
    layerInitializer.js no lo maneja hoy porque nunca se resuelve a un
    valor técnico real). Se audita contra el protocolo igual que
    cualquier otro valor: un WMS marcado CONDICIONAL sigue necesitando
    BBOX como método de acceso técnico; lo condicional es SOLO a qué
    municipios aplica, ver resolver_condicional().
    """
    valor_excel = (capa.get("disponibilidad_municipal") or "").upper()
    conjunto = heuristica_disponibilidad_base(capa.get("tipo", "").upper())
    if conjunto is None:
        return None, valor_excel, None  # WFS o ATOM/API: pendiente de red o no auditable

    if valor_excel == "CONDICIONAL":
        return True, valor_excel, conjunto  # pasa siempre; se resuelve aparte

    return valor_excel in conjunto, valor_excel, conjunto


def auditar_disponibilidad_wfs(capa: dict, root: ET.Element) -> tuple[bool, str, set]:
    """Auditoría para WFS, ya con capabilities descargado."""
    valor_excel = (capa.get("disponibilidad_municipal") or "").upper()
    conjunto = heuristica_disponibilidad_wfs(root)

    if valor_excel == "CONDICIONAL":
        return True, valor_excel, conjunto  # pasa siempre; se resuelve aparte

    return valor_excel in conjunto, valor_excel, conjunto


def resolver_condicional(capa: dict, conjunto_tecnico: set) -> tuple[str, str | None]:
    """
    Resuelve CONDICIONAL a un valor técnico real que layerInitializer.js
    sí sabe interpretar (BBOX/FILTRABLE/DIRECTA) — su switch no tiene caso
    para CONDICIONAL, cae siempre al default con un warning (confirmado
    leyendo el código real, 25/08/2026).

    CORRECCIÓN de semántica (mismo hallazgo): campo_filtro NO es una lista
    de códigos INE — es el NOMBRE DEL ATRIBUTO contra el que
    layerInitializer._estrategiaFiltrable() arma el CQL_FILTER /
    definitionExpression (ej. "codigo_ine"). La versión anterior de esta
    función lo trataba como lista de códigos, error de diseño ya corregido.
    Si el Excel no declara campo_filtro (hoy vacío en las 127 filas), no
    hay nombre de atributo que usar y el valor técnico cae al default del
    protocolo — layerInitializer.js maneja esto sin fallar (verifica
    !campoFiltro y omite el filtro con un warning, no lanza excepción).

    Devuelve (valor_tecnico, campo_filtro_o_None).
    """
    campo_filtro = (capa.get("campo_filtro") or "").strip() or None
    valor_tecnico = "BBOX" if "BBOX" in conjunto_tecnico else sorted(conjunto_tecnico)[0]
    return valor_tecnico, campo_filtro


# ─────────────────────────────────────────────
# VALIDACIÓN DE ESQUEMA MÍNIMO
# ─────────────────────────────────────────────

def validar_esquema_minimo(capa: dict) -> list:
    """Devuelve la lista de campos obligatorios ausentes o vacíos."""
    faltantes = []
    for campo in CAMPOS_OBLIGATORIOS:
        valor = capa.get(campo)
        if valor is None or valor == "" or valor == {}:
            faltantes.append(campo)
    return faltantes


# ─────────────────────────────────────────────
# RESOLUCIÓN DE UNA CAPA
# ─────────────────────────────────────────────

def resolver_capa(capa: dict) -> dict:
    """
    Devuelve la capa enriquecida con _resolucion añadido, o marca
    estado de exclusión si no se puede resolver. No escribe formato
    final aquí — eso lo hace main() tras filtrar por estado.
    """
    tipo = (capa.get("tipo") or "").upper()
    resolucion = {"fecha": datetime.date.today().isoformat(), "pendiente_curacion": []}

    # ── Auditoría de disponibilidad_municipal, parte 1: sin red ──
    # Para WMS/WMTS/XYZ el protocolo ya decide (solo BBOX es físicamente
    # posible) y se excluye aquí sin gastar ninguna petición. Para WFS
    # coincide=None: no hay señal barata, se resuelve más abajo una vez
    # descargado el capabilities real (ver heuristica_disponibilidad_wfs).
    # Para ATOM/API REST coincide=None también: no auditable, se acepta
    # el valor del Excel sin más (ver heuristica_disponibilidad_base).
    coincide, valor_excel, conjunto = auditar_disponibilidad_base(capa)
    if coincide is False:
        resolucion["estado"] = "excluida_discrepancia"
        resolucion["discrepancia_disponibilidad_municipal"] = {
            "excel": valor_excel, "plausibles_por_protocolo": sorted(conjunto),
        }
        capa["_resolucion"] = resolucion
        return capa

    if valor_excel == "CONDICIONAL" and conjunto is not None:
        valor_resuelto, campo_filtro = resolver_condicional(capa, conjunto)
        capa["disponibilidad_municipal"] = valor_resuelto
        if campo_filtro:
            resolucion["pendiente_curacion"].append(
                f"CONDICIONAL resuelto a '{valor_resuelto}'; campo_filtro='{campo_filtro}' "
                "declarado — considerar si en realidad debería ser FILTRABLE en vez de BBOX"
            )
        else:
            resolucion["pendiente_curacion"].append(
                f"CONDICIONAL resuelto a '{valor_resuelto}' por defecto de protocolo — "
                "campo_filtro vacío en el Excel, sin atributo declarado para filtrar por territorio"
            )

    # ── Tipos sin GetCapabilities estándar: quedan tal cual, sin red ──
    if tipo not in ("WMS", "WMTS", "WFS", "WCS"):
        resolucion["estado"] = "ok"
        resolucion["pendiente_curacion"].append(
            f"tipo '{tipo}' sin GetCapabilities estándar — formatos/sublayers no derivados, revisar a mano"
        )
        capa["_resolucion"] = resolucion
        return capa

    url = construir_url_capabilities(capa)
    if not url:
        resolucion["estado"] = "excluida_error_red"
        resolucion["motivo"] = "sin capabilities_url ni url base para construirla"
        capa["_resolucion"] = resolucion
        return capa

    root, estado_fetch = fetch_xml(url)
    if root is None:
        if estado_fetch.startswith("servicio_caido"):
            # A diferencia de error_red/xml_invalido (que sí excluyen la
            # capa del catálogo), un servicio_caido detectado vía
            # ServiceExceptionReport SÍ se incluye en catalogo-capas.json,
            # pero marcado con servicio_disponible=false. Motivo: el
            # servicio existe y está correctamente configurado en el
            # catálogo (URL válida, proveedor real, capa legítima) — el
            # problema es una caída puntual del lado del servidor, no un
            # error de configuración del cliente. Excluirla del catálogo
            # borraría el ítem del árbol sin dejar rastro para el usuario
            # final; incluirla deshabilitada permite que layerTree.js
            # muestre un estado "no disponible" en vez de que la capa
            # simplemente no exista.
            resolucion["estado"] = "ok_servicio_caido"
            resolucion["servicio_disponible"] = False
            resolucion["motivo_caida"] = estado_fetch
            capa["_resolucion"] = resolucion
            # Promovido a nivel raíz (no solo dentro de _resolucion): el
            # pipeline de carga de la app (configEngine.js/LocalJsonAdapter.js)
            # puede no preservar objetos de metadatos anidados del catálogo
            # al construir el config que llega a layerTree.js. Un campo plano
            # es más robusto frente a ese recorte — confirmar de todas formas
            # revisando ese pipeline antes de asumir que llega intacto.
            capa["servicio_disponible"] = False
            return capa

        resolucion["estado"] = ("excluida_xml_invalido" if "xml_invalido" in estado_fetch
                                 else "excluida_error_red")
        resolucion["motivo"] = estado_fetch
        capa["_resolucion"] = resolucion
        return capa

    # ── Auditoría de disponibilidad_municipal, parte 2: solo WFS ──
    # Aquí sí se gastó la petición de red, pero es la única forma de
    # obtener la señal real (atributo de código INE declarado o no).
    if tipo == "WFS":
        coincide_wfs, valor_excel_wfs, conjunto_wfs = auditar_disponibilidad_wfs(capa, root)
        if not coincide_wfs:
            resolucion["estado"] = "excluida_discrepancia"
            resolucion["discrepancia_disponibilidad_municipal"] = {
                "excel": valor_excel_wfs, "plausibles_segun_capabilities": sorted(conjunto_wfs),
            }
            capa["_resolucion"] = resolucion
            return capa

        if valor_excel_wfs == "CONDICIONAL":
            valor_resuelto, campo_filtro = resolver_condicional(capa, conjunto_wfs)
            capa["disponibilidad_municipal"] = valor_resuelto
            if campo_filtro:
                resolucion["pendiente_curacion"].append(
                    f"CONDICIONAL resuelto a '{valor_resuelto}'; campo_filtro='{campo_filtro}' "
                    "declarado — considerar si en realidad debería ser FILTRABLE en vez de BBOX"
                )
            else:
                resolucion["pendiente_curacion"].append(
                    f"CONDICIONAL resuelto a '{valor_resuelto}' por defecto de protocolo — "
                    "campo_filtro vacío en el Excel, sin atributo declarado para filtrar por territorio"
                )

    # ── Derivación de campos (solo WMS tiene la extracción completa
    #     de sublayers/srs/featureInfoFormat implementada; WFS/WMTS/WCS
    #     solo resuelven formatos por ahora) ──
    formatos_salida, formato_consumo = resolver_formatos(tipo, root)
    capa["formatos_salida"] = formatos_salida

    if tipo == "WFS" and formato_consumo is None:
        resolucion["estado"] = "excluida_error_red"
        resolucion["motivo"] = "WFS sin GeoJSON confirmado por el servicio (requisito WFSLayer SDK v5)"
        capa["_resolucion"] = resolucion
        return capa

    capa["formato_consumo"] = formato_consumo

    if tipo == "WFS":
        srs_wfs = extraer_srs_wfs(root)
        capa["srsname"] = srs_wfs
        if srs_wfs is None:
            resolucion["pendiente_curacion"].append(
                "srsname: ningún DefaultSRS/DefaultCRS declarado por el servicio — "
                "layerInitializer.js usará EPSG:4326 por defecto para el filtro BBOX, "
                "verificar si el servicio real lo requiere en otro CRS"
            )

    if tipo == "WMS":
        capa_raiz = _localizar_capa_raiz(root)
        if capa_raiz is not None:
            srs = extraer_srs_preferido(root, capa_raiz)
            capa["srsname"] = srs
            if srs is None:
                resolucion["pendiente_curacion"].append("srsname: ningún CRS declarado por el servicio")

            fif = extraer_feature_info_format(root)
            capa["featureInfoFormat"] = fif
            if fif is None:
                resolucion["pendiente_curacion"].append("featureInfoFormat: no declarado por el servicio")

            sublayers = extraer_sublayers(root, capa)
            for sub in sublayers:
                if sub["legendUrl"] is None:
                    resolucion["pendiente_curacion"].append(
                        f"legendUrl de sublayer '{sub['id']}': {sub['_legend_motivo']}"
                    )
                sub.pop("_legend_motivo", None)
            capa["sublayers"] = sublayers
        else:
            resolucion["pendiente_curacion"].append("no se localizó Capability/Layer raíz — sublayers no derivados")

    resolucion["estado"] = "ok_con_pendientes" if resolucion["pendiente_curacion"] else "ok"
    capa["_resolucion"] = resolucion
    return capa


# ─────────────────────────────────────────────
# DIFF CONTRA LA EJECUCIÓN ANTERIOR
# ─────────────────────────────────────────────

def calcular_diff(catalogo_nuevo: list, ruta_anterior: Path) -> dict:
    if not ruta_anterior.exists():
        return {"primera_ejecucion": True}

    with open(ruta_anterior, encoding="utf-8") as f:
        anterior = json.load(f)

    ids_anteriores = {c["id"]: c for c in anterior}
    ids_nuevos     = {c["id"]: c for c in catalogo_nuevo}

    nuevas      = sorted(set(ids_nuevos) - set(ids_anteriores))
    eliminadas  = sorted(set(ids_anteriores) - set(ids_nuevos))
    modificadas = []

    campos_a_comparar = ["disponibilidad_municipal", "formato_consumo", "url", "tipo"]
    for id_ in set(ids_nuevos) & set(ids_anteriores):
        cambios = {}
        for campo in campos_a_comparar:
            v_antes = ids_anteriores[id_].get(campo)
            v_ahora = ids_nuevos[id_].get(campo)
            if v_antes != v_ahora:
                cambios[campo] = {"antes": v_antes, "ahora": v_ahora}
        if cambios:
            modificadas.append({"id": id_, "cambios": cambios})

    return {
        "primera_ejecucion": False,
        "nuevas": nuevas,
        "eliminadas": eliminadas,
        "modificadas": modificadas,
    }


# ─────────────────────────────────────────────
# EJECUCIÓN PRINCIPAL
# ─────────────────────────────────────────────

def parsear_argumentos():
    """
    Parseo de argumentos de línea de comandos. Se mantiene compatible con
    el uso posicional original (python enriquecer-catalogo.py archivo.json)
    y se añade --solo-fallidas como bandera opcional, sin cambiar el
    comportamiento por defecto (corrida completa) si no se pasa.
    """
    parser = argparse.ArgumentParser(
        description="Resuelve catalogo-capas-ne.json contra GetCapabilities real.",
    )
    parser.add_argument(
        "archivo_entrada",
        nargs="?",
        default=ARCHIVO_ENTRADA,
        help=f"Ruta al catalogo-capas-ne.json (default: {ARCHIVO_ENTRADA})",
    )
    parser.add_argument(
        "--solo-fallidas",
        action="store_true",
        help=(
            "Reprocesa solo las candidatas que NO quedaron incluidas en la "
            "última corrida (lee catalogo-capas.json anterior). Las que ya "
            "estaban ok/ok_con_pendientes se reutilizan sin volver a golpear "
            "el servicio. Solo para iterar rápido durante depuración — no "
            "reemplaza una corrida completa antes de dar el catálogo por "
            "definitivo."
        ),
    )
    return parser.parse_args()


def cargar_capas_exitosas_anteriores(ruta_salida: Path) -> dict:
    """
    Lee catalogo-capas.json de la corrida anterior, si existe, y devuelve
    un dict {id: capa} con las capas que ya estaban resueltas con éxito
    (ok/ok_con_pendientes — es lo único que ese archivo contiene, ya que
    las excluidas nunca se escriben ahí, solo quedan documentadas en el
    informe). Devuelve {} si el archivo no existe (primera corrida).
    """
    if not ruta_salida.exists():
        return {}
    with open(ruta_salida, encoding="utf-8") as f:
        anterior = json.load(f)
    return {c["id"]: c for c in anterior}


def main():
    args = parsear_argumentos()

    print("═══════════════════════════════════════════════════════")
    print("  Resolución de catálogo final desde GetCapabilities")
    if args.solo_fallidas:
        print("  Modo: --solo-fallidas (reutiliza capas ya exitosas, sin red)")
    print("═══════════════════════════════════════════════════════\n")

    ruta_entrada = Path(args.archivo_entrada)
    if not ruta_entrada.exists():
        print(f"❌ Archivo no encontrado: {ruta_entrada}")
        sys.exit(1)

    with open(ruta_entrada, encoding="utf-8") as f:
        catalogo_ne = json.load(f)

    candidatas = [c for c in catalogo_ne if c.get("incluir_en_catalogo_final")]
    print(f"📄 Capas en catalogo-capas-ne.json: {len(catalogo_ne)}")
    print(f"🎯 Candidatas (incluir_en_catalogo_final=true): {len(candidatas)}\n")

    ruta_salida = ruta_entrada.parent / ARCHIVO_SALIDA

    # ── Modo --solo-fallidas: separar candidatas ya exitosas de las que
    #    hay que reprocesar. Las exitosas se reutilizan tal cual (mismo
    #    _resolucion que tenían, solo se les añade una nota de que no se
    #    volvió a consultar el servicio en esta corrida) ──
    reutilizadas = []
    if args.solo_fallidas:
        exitosas_anteriores = cargar_capas_exitosas_anteriores(ruta_salida)
        if not exitosas_anteriores:
            print("⚠️  --solo-fallidas: no hay catalogo-capas.json previo, "
                  "se procesan todas las candidatas igual que en corrida completa.\n")
        candidatas_a_procesar = []
        for capa in candidatas:
            previa = exitosas_anteriores.get(capa.get("id"))
            if previa is not None:
                previa = dict(previa)  # copia, no mutar el dict cacheado
                previa.setdefault("_resolucion", {})
                previa["_resolucion"]["reutilizada_sin_red"] = True
                reutilizadas.append(previa)
            else:
                candidatas_a_procesar.append(capa)
        print(f"♻️  Reutilizadas sin red (ya ok en corrida anterior): {len(reutilizadas)}")
        print(f"🔁 A reprocesar (fallaron antes o son nuevas): {len(candidatas_a_procesar)}\n")
        candidatas = candidatas_a_procesar

    catalogo_final = list(reutilizadas)
    excluidas      = []

    for i, capa in enumerate(candidatas):
        nombre = capa.get("title") or capa.get("id") or f"capa_{i}"
        print(f"  [{i+1:>3}/{len(candidatas)}] {nombre[:60]}", end=" ... ", flush=True)

        capa_resuelta = resolver_capa(capa)
        estado = capa_resuelta["_resolucion"]["estado"]

        if estado == "ok_servicio_caido":
            print(f"⚠️  ok_servicio_caido (incluida, deshabilitada en árbol)")
            catalogo_final.append(capa_resuelta)
            continue

        if estado.startswith("excluida"):
            print(f"❌ {estado}")
            excluidas.append(capa_resuelta)
            continue

        faltantes = validar_esquema_minimo(capa_resuelta)
        if faltantes:
            print(f"❌ esquema incompleto: {faltantes}")
            capa_resuelta["_resolucion"]["estado"] = "excluida_esquema_incompleto"
            capa_resuelta["_resolucion"]["campos_faltantes"] = faltantes
            excluidas.append(capa_resuelta)
            continue

        icono = "✅" if estado == "ok" else "⚠️ "
        print(f"{icono} {estado}")
        catalogo_final.append(capa_resuelta)

    diff = calcular_diff(catalogo_final, ruta_salida)

    with open(ruta_salida, "w", encoding="utf-8") as f:
        json.dump(catalogo_final, f, ensure_ascii=False, indent=2)

    # ── Informe ──
    ruta_informe = ruta_entrada.parent / ARCHIVO_INFORME
    with open(ruta_informe, "w", encoding="utf-8") as f:
        f.write(f"Informe de resolución de catálogo — {datetime.date.today()}\n")
        f.write("=" * 60 + "\n\n")
        if args.solo_fallidas:
            f.write("MODO: --solo-fallidas — las capas marcadas 'reutilizada_sin_red'\n")
            f.write("no fueron consultadas en esta corrida; su estado corresponde a\n")
            f.write("la última vez que sí se verificaron contra el servicio real.\n\n")
        f.write(f"Candidatas evaluadas: {len(candidatas) + len(reutilizadas)}\n")
        f.write(f"  De las cuales reutilizadas sin red: {len(reutilizadas)}\n")
        f.write(f"  De las cuales reprocesadas contra el servicio: {len(candidatas)}\n")
        f.write(f"Incluidas en catálogo final: {len(catalogo_final)}\n")
        f.write(f"Excluidas: {len(excluidas)}\n\n")

        f.write("── Excluidas ──\n")
        for c in excluidas:
            r = c["_resolucion"]
            f.write(f"  [{r['estado']}] {c.get('title', c.get('id'))}\n")
            if "discrepancia_disponibilidad_municipal" in r:
                d = r["discrepancia_disponibilidad_municipal"]
                clave_plausibles = "plausibles_por_protocolo" if "plausibles_por_protocolo" in d else "plausibles_segun_capabilities"
                f.write(f"      Excel: {d['excel']}  |  Plausibles: {d[clave_plausibles]}\n")
            if "motivo" in r:
                f.write(f"      motivo: {r['motivo']}\n")
            if "campos_faltantes" in r:
                f.write(f"      campos faltantes: {r['campos_faltantes']}\n")

        f.write("\n── Incluidas con pendientes de curación manual ──\n")
        for c in catalogo_final:
            pendientes = c["_resolucion"].get("pendiente_curacion", [])
            if pendientes:
                f.write(f"  {c['title']} ({c['id']}):\n")
                for p in pendientes:
                    f.write(f"      - {p}\n")

        f.write("\n── Incluidas pero con servicio caído (deshabilitadas en el árbol) ──\n")
        capas_caidas = [c for c in catalogo_final
                        if c["_resolucion"].get("estado") == "ok_servicio_caido"]
        if not capas_caidas:
            f.write("  Ninguna.\n")
        for c in capas_caidas:
            f.write(f"  {c['title']} ({c['id']}):\n")
            f.write(f"      motivo_caida: {c['_resolucion'].get('motivo_caida')}\n")

        if args.solo_fallidas and reutilizadas:
            f.write("\n── Reutilizadas sin red (no verificadas en esta corrida) ──\n")
            for c in reutilizadas:
                f.write(f"  {c['title']} ({c['id']})\n")

        f.write("\n── Diff contra ejecución anterior ──\n")
        if diff.get("primera_ejecucion"):
            f.write("  Primera ejecución — no hay comparación previa.\n")
        else:
            f.write(f"  Nuevas: {diff['nuevas']}\n")
            f.write(f"  Eliminadas: {diff['eliminadas']}\n")
            f.write(f"  Modificadas:\n")
            for m in diff["modificadas"]:
                f.write(f"    {m['id']}: {m['cambios']}\n")

    # ── Resumen en consola ──
    print("\n" + "─" * 55)
    if args.solo_fallidas:
        print(f"♻️  Reutilizadas sin red: {len(reutilizadas)}")
    n_caidas = sum(1 for c in catalogo_final if c["_resolucion"].get("estado") == "ok_servicio_caido")
    print(f"✅ Incluidas en catálogo final: {len(catalogo_final)}")
    if n_caidas:
        print(f"   (de las cuales {n_caidas} con servicio caído, deshabilitadas en árbol)")
    print(f"❌ Excluidas: {len(excluidas)}")
    if not diff.get("primera_ejecucion"):
        print(f"↔️  Diff — nuevas: {len(diff['nuevas'])}, eliminadas: {len(diff['eliminadas'])}, "
              f"modificadas: {len(diff['modificadas'])}")
    print(f"\n📦 Catálogo final: {ruta_salida}")
    print(f"📋 Informe:        {ruta_informe}")
    if args.solo_fallidas:
        print("\n⚠️  Corrida en modo --solo-fallidas: antes de dar el catálogo por")
        print("   definitivo, correr sin esta bandera al menos una vez para")
        print("   confirmar que las capas reutilizadas siguen funcionando hoy.")
    print("═══════════════════════════════════════════════════════\n")


if __name__ == "__main__":
    main()