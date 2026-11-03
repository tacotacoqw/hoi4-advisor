idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")
# main.c 里用到了 tusb.h（调试串口），TinyUSB 要求先告诉它芯片型号
target_compile_definitions(${COMPONENT_LIB} PRIVATE CFG_TUSB_MCU=OPT_MCU_ESP32S3)
