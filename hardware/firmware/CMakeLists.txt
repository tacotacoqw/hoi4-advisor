cmake_minimum_required(VERSION 3.16.0)
# 离线构建时可关闭组件管理器，直接使用已经下载到工程内的组件。
if("$ENV{IDF_COMPONENT_MANAGER}" STREQUAL "0")
    list(APPEND EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/managed_components/espressif__tinyusb"
         "${CMAKE_CURRENT_LIST_DIR}/managed_components/espressif__cmake_utilities")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(field-telegraph)
