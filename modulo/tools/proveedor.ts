// Módulo reutilizable — re-exporta las herramientas sin depender del servidor HTTP
export {
  leer_solicitud as proveedor_leer_solicitud,
  mapear_campos as proveedor_mapear_campos,
  generar_formulario as proveedor_generar_formulario,
  armar_paquete as proveedor_armar_paquete,
  simular_envio as proveedor_simular_envio,
} from "../src/tools/proveedor.ts";
