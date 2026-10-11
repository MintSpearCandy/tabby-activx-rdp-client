{
  "targets": [
    {
      "target_name": "rdp_host",
      "sources": ["native/rdp_host.cpp", "native/addon.cc"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "native",
        "D:/App/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.43.34808/atlmfc/include"
      ],
      "defines": ["UNICODE", "_UNICODE", "_WIN32_WINNT=0x0A00", "NAPI_VERSION=8"],
      "libraries": ["atls.lib"],
      "configurations": {
        "Debug": { "msvs_windows_target_platform_version": "10.0.26100.0" },
        "Release": { "msvs_windows_target_platform_version": "10.0.26100.0" }
      },
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": "1"
        },
        "VCLinkerTool": {
          "AdditionalLibraryDirectories": [
            "D:/App/Microsoft Visual Studio/2022/Community/VC/Tools/MSVC/14.43.34808/atlmfc/lib/x64"
          ],
          "GenerateMapFile": "true",
          "MapFileName": "$(OutDir)rdp_host.map",
          "GenerateDebugInformation": "true"
        }
      }
    }
  ]
}
