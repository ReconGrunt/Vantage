' main.brs — LivelySky Radar entry points.
'
' One package serves two roles (verified Roku pattern):
'   Main()            -> launched from the Home screen: the interactive radar.
'   RunScreenSaver()  -> shown by the Screensaver picker: an ambient, render-only
'                        sweeping radar. No remote input is delivered here, so this
'                        path never wires up key handling.
' Both reuse the same RadarView; only the wrapping Scene differs.

sub Main(args as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)

    scene = screen.CreateScene("RadarScene")
    screen.show()

    ' forward any deep-link / launch args (unused today, future-proofing)
    if args <> invalid then scene.setField("launchArgs", args)

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        end if
    end while
end sub

sub RunScreenSaver()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)

    screen.CreateScene("ScreensaverScene")
    screen.show()

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        end if
    end while
end sub
