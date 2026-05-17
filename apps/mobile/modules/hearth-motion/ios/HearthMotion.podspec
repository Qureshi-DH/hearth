Pod::Spec.new do |s|
  s.name           = 'HearthMotion'
  s.version        = '0.1.0'
  s.summary        = 'Motion and activity signals from the OS'
  s.description    = 'Reports what the phone is doing so Hearth can keep the GPS asleep.'
  s.author         = 'Hearth'
  s.homepage       = 'https://github.com/Qureshi-DH/hearth'
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: 'https://github.com/Qureshi-DH/hearth' }
  s.static_framework = true
  s.license        = { :type => 'AGPL-3.0' }

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreMotion'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
