#!/usr/bin/env node
/* eslint-disable camelcase */
/* eslint-disable require-await */
/* eslint-disable no-console */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

import { discover } from '../../index.js'

// --| Utilities ------------------------
const commands = import('./commands.mjs')

import { lightOrDark, HSLToRGB } from './functions.mjs'
import { MqttSetup } from './mqtt_listener.mjs'
import { startWatcher, handleNotification } from './notification.mjs'
import config from './config.mjs'
// import * as colorTools from 'color_tools.mjs';

// --| Imports --------------------------
const path = require('path')
const fsPromises = require('node:fs/promises')
import JSON5 from 'json5'
const __dirname = path.resolve()

let mutex = false
let conf
let loupedeck
const colors = ['#f66', '#f95', '#fb4', '#fd6', '#ff9', '#be9', '#9e9', '#9db', '#9cc', '#88c', '#c9c', '#d89']

while (!loupedeck) {
    try {
        loupedeck = await discover()
    } catch (e) {
        console.error(`${e}. Reattempting in 3 seconds...`)
        await new Promise(res => setTimeout(res, 3000))
    }
}
let brightness = 1
let vibration = 0
let mqttClient

const totalKeys = 14
const alertDict = {}

for (let i = 0; i < totalKeys; i++) {
    alertDict[i] = false
}

// --| Example MQTT Message ------------
const jsonExample = `
{
    "path":"loupedeck/incoming/",
    "inputType":"button/touch/knob",
    "inputNum": 1,
    "message":"Message Text!",
    "data": {}
}
`

// --| OnConnect ----------------------
loupedeck.on('connect', async ({ address }) => {
    conf = await config.readConfig()

    console.info(`✅ Connected to ${loupedeck.type} at ${address}`)
    const { serial, version } = await loupedeck.getInfo()
    console.info(`Device serial number ${serial}, software version ${version}`)

    const bright = conf.settings.brightness
    const delta = 0
    const d = delta + 0.1

    // --| Mqtt Listener -------------------
    if (conf.mqtt.enabled === 1) {
        mqttClient = MqttSetup(conf)
        mqttClient.on('message', (topic, message) => {
            const msgJson = JSON5.parse(message.toString())

            const inputType = msgJson.inputType
            const keyIndex = msgJson.inputNum
            const msgText = msgJson.message
            const msgData = msgJson.data

            // --| Message Notification ---
            if (inputType === 'button') {
                console.log(`Button: ${msgJson.inputNum.toString()}`)
            } else if (inputType === 'touch') {
                loupedeck.drawKey(keyIndex, (ctx, w, h) => {
                    alertDict[keyIndex] = true
                    drawInboundTouch(keyIndex, msgJson, ctx, w, h)
                })
                cycleTouchAlert(loupedeck, keyIndex, msgJson)
            } else if (inputType === 'knob') {
                console.log(`Knob: ${msgJson.inputNum.toString()}`)
            }
        })
    } else {
        console.log('Mqtt connection disabled in config.')
    }
    // --| Notification listener -----------
    startWatcher(conf.settings.notification_path, loupedeck)

    loupedeck.setBrightness(bright)
    await drawKeyColors(loupedeck)
    cycleColors(loupedeck)
})

function cycleTouchAlert(loupedeck, keyIndex, msgJson) {
    let i = 0
    const r = 255
    const g = 0
    const b = 10
    const initialized = false
    const msgData = msgJson

    let hue = 0
    const bgSteps = 50,
        dr = (255 - r) / bgSteps,
        dg = (255 - g) / bgSteps,
        db = (255 - b) / bgSteps

    const interval = setInterval(() => {
        if (alertDict[keyIndex] === false) {
            clearInterval(interval)
            return
        }

        hue = hue + Math.random() * 3

        const h1 = hue
        const s1 = '100'
        const l1 = '50'

        const color = `rgba(${Math.round(r + dr * i)},${
            Math.round(g + dg * i)},${
            Math.round(b + db * i)})`

        loupedeck.drawKey(keyIndex, (ctx, w, h) => {
            drawInboundTouch(keyIndex, msgData, ctx, w, h, h1, s1, l1)
            i++

            if (i === bgSteps) {
                i = 0
            }
        })
    }, 50)
}

function drawInboundTouch(keyIndex, msgJson, ctx, w, h, h1, s1, l1) {
    const msgArray = msgJson.data.messages.length > 0 ? msgJson.data.messages : [msgJson.message]
    const color = `hsl(${h1}, ${s1}% , ${l1}%)`

    ctx.fillStyle = color
    ctx.fillRect(0, 0, w, h)

    const bgLum = lightOrDark(HSLToRGB(h1, s1, l1))

    if (bgLum.includes('dark')) {
        ctx.fillStyle = '#FF0000'
    } else {
        ctx.fillStyle = '#222222'
    }

    ctx = getTextArray(ctx, keyIndex, msgArray)
    ctx = setButtonNumber(ctx, keyIndex)
}

// --| OnDisconnect -------------------
loupedeck.on('disconnect', err => {
    console.info(`Connection to Loupedeck lost (${err?.message}). Reconnecting in ${loupedeck.reconnectInterval / 1000}s...`)
})

// --| OnButtonDown -------------------
loupedeck.on('down', async ({ id }) => {
    console.log(`Button ${id} pressed`)
    if (mutex) return
    mutex = true

    // if (id === 0) drawKeyColors(loupedeck)

    let indicator
    let output

    let cmdType = ''
    let cmd = ''

    if (conf.button[id] === undefined) {
        console.log(`No configuration found for button ${id} `)
        console.warn('PLEASE UPDATE YOUR CONFIG')
    }else{
        cmdType = conf.button[id].cmd_type
        cmd = conf.button[id].command
    }

    if (cmdType === 'shell') {
        if (cmd !== '' && cmd !== undefined) {
            try {
                output = await (await commands).runCommand(cmd)
            } catch (error) {
                console.log(error)
            }

            if (output !== '') {
                output = output.toString()
            }

            if (output.trim().toLowerCase().includes('ON'.toLowerCase())) {
                indicator = conf.settings.enabled_indicator
                console.log(`indicator: ${indicator}`)
            } else if (output.trim().toLowerCase().includes('OFF'.toLowerCase())) {
                indicator = conf.settings.disabled_indicator
                console.log(`indicator: ${indicator}`)
            }
        }
    }
    // Only use mqtt if setup for it was done, there is a config setting to enable it
    if (mqttClient !== undefined) {
        if (cmdType === 'mqtt') {
            const topicString = `loupedeck/outgoing/touch/${id}`
            mqttClient.publish(topicString, cmd)
        }
    }
    mutex = false
})

// --| OnButtonUp ---------------------
loupedeck.on('up', async ({ id }) => {
    console.log(`Button ${id} released`)
})

// --| OnKnobRotate -------------------
loupedeck.on('rotate', async ({ id, delta }) => {
    if (mutex) return
    mutex = true
    console.log(`Knob ${id} rotated ${delta > 0 ? 'right' : 'left'}`)

    let output

    let cmd = ''
    if (conf.wheel[id] === undefined) {
        console.log(`No configuration found for wheel ${id} `)
        console.warn('PLEASE UPDATE YOUR CONFIG')
    }else{
        cmd = delta > 0 ? conf.wheel[id].right.command : conf.wheel[id].left.command
    }

    if (id === 'knobTL') {
        if (cmd === '' || cmd === undefined) {
            vibration = Math.min(0xff, Math.max(0, vibration + delta))
            console.log(`Testing vibration #${vibration}`)
            loupedeck.vibrate(vibration)
        } else {
            try {
                output = await (await commands).runCommand(cmd)
            } catch (error) {
                console.log(error)
            }

            if (output !== '') {
                output = output.toString()
            }

            console.log(output)
            if (output.trim().toLowerCase().includes('ON'.toLowerCase())) {
                console.log(`indicator: ${id}`)
            } else if (output.trim().toLowerCase().includes('OFF'.toLowerCase())) {
                console.log(`indicator: ${id}`)
            }
        }
    }

    if (id === 'knobCL') {
        if (cmd === '' || cmd === undefined) {
            brightness = Math.min(1, Math.max(0, brightness + delta * 0.1))
            console.log(`Setting brightness level ${Math.round(brightness * 100)}%`)
            loupedeck.setBrightness(brightness)
        } else {
            try {
                output = await (await commands).runCommand(cmd)
            } catch (error) {
                console.log(error)
            }

            if (output !== '') {
                output = output.toString()
            }

            console.log(output)
            if (output.trim().toLowerCase().includes('ON'.toLowerCase())) {
                console.log(`indicator: ${id}`)
            } else if (output.trim().toLowerCase().includes('OFF'.toLowerCase())) {
                console.log(`indicator: ${id}`)
            }
        }
    }

    mutex = false
})

// --| OnTouchStart -------------------
loupedeck.on('touchstart', async ({ changedTouches: [touch] }) => {
    const keyIndex = touch.target.key

    if (alertDict[keyIndex]) {
        alertDict[keyIndex] = false
    }

    // Clear key when touched
    if (touch.target.key !== undefined) {
        loupedeck.drawKey(touch.target.key, (ctx, w, h) => {
            ctx.fillStyle = getPressedBackground(keyIndex)
            ctx.fillRect(0, 0, w, h)

            ctx.fillStyle = getFontDownColor(keyIndex)
            getText(ctx, keyIndex)

            setButtonNumber(ctx, keyIndex)
        })
    }
})

// --| OnTouchMove --------------------
loupedeck.on('touchmove', ({ changedTouches: [touch] }) => {
    console.log(`Touch #${touch.id} moved: x: ${touch.x}, y: ${touch.y}`)
})

// --| OnTouchEnd ---------------------
loupedeck.on('touchend', async ({ changedTouches: [touch] }) => {
    const keyIndex = touch.target.key
    let indicator
    let output = ''

    let cmdType = ''
    let cmd = ''
    if (conf.touch[keyIndex] === undefined) {
        console.log(`No configuration found for touch ${keyIndex} `)
        console.warn('PLEASE UPDATE YOUR CONFIG')
    }else{
        cmdType = conf.touch[keyIndex].cmd_type
        cmd = conf.touch[keyIndex].command
    }

    if (cmdType === 'shell') {
        if (cmd !== '' && cmd !== undefined) {
            try {
                output = await (await commands).runCommand(cmd)
            } catch (error) {
                console.log(error)
            }

            if (output !== '') {
                output = output.toString()
            }

            if (output.trim().toLowerCase().includes('ON'.toLowerCase())) {
                indicator = conf.settings.enabled_indicator
                console.log(`indicator: ${indicator}`)
            } else if (output.trim().toLowerCase().includes('OFF'.toLowerCase())) {
                indicator = conf.settings.disabled_indicator
                console.log(`indicator: ${indicator}`)
            }
        }
    }
    // Only use mqtt if setup for it was done, there is a config setting to enable it
    if (mqttClient !== undefined) {
        if (cmdType === 'mqtt') {
            const topicString = `loupedeck/outgoing/touch/${keyIndex}`
            mqttClient.publish(topicString, cmd)
        }
    }
    // --| If overlay text is not set, return
    // if (conf.touch[keyIndex].press_overlay.text == "") { return; }
    let overlay_text = ''
    if (conf.touch[keyIndex] === undefined) {
        console.log(`No configuration found for touch ${keyIndex} `)
        console.warn('PLEASE UPDATE YOUR CONFIG')
    }else{
        overlay_text = conf.touch[keyIndex].press_overlay.text
        console.log('Overlay Text', overlay_text)
    }
    if (keyIndex !== undefined) {
        loupedeck.drawKey(keyIndex, (ctx, w, h) => {
            ctx.fillStyle = getBackground(keyIndex)
            ctx.fillRect(0, 0, w, h)

            ctx.fillStyle = getFontColor(keyIndex)
            getText(ctx, keyIndex)

            if (indicator !== undefined) {
                getIndicator(ctx, indicator)
            }

            setButtonNumber(ctx, keyIndex)
        })
    }
})

// Cycle through random button colors
function cycleColors(device) {
    let idx = 0
    setInterval(() => {
        const id = device.buttons[idx]
        const r = Math.round(Math.random() * 255)
        const g = Math.round(Math.random() * 255)
        const b = Math.round(Math.random() * 255)
        device.setButtonColor({ id, color: `rgba(${r}, ${g}, ${b})` })
        idx = (idx + 1) % device.buttons.length
    }, 200)
}

// --| Helper Functions --------------------
// --| Draw solid colors on each key -------
async function drawKeyColors(device) {
    for (let i = 0; i < device.rows * device.columns; i++) {
        await device.drawKey(i, (ctx, w, h) => {
            ctx.fillStyle = getBackground(i)
            ctx.fillRect(0, 0, w, h)

            ctx.fillStyle = getFontColor(i)
            getText(ctx, i)

            setButtonNumber(ctx, i)
        })
    }
}

// --| Per-key Startup Commands ------------
// --| Primarily For Dynamic Indicators ----
async function runStartCommand(keyIndex) {
    const cmd = conf.touch[keyIndex].command
    let output = ''
    if (cmd !== '' && cmd !== undefined) {
        try {
            output = await (await commands).runCommand(cmd)
        } catch (error) {
            console.log(error)
        }

        if (output !== '') {
            output = output.toString()
        }

        if (output.trim().toLowerCase().includes('ON'.toLowerCase())) {
            const indicator = conf.settings.enabled_indicator
            console.log(`indicator: ${indicator}`)
        } else if (output.trim().toLowerCase().includes('OFF'.toLowerCase())) {
            const indicator = conf.settings.disabled_indicator
            console.log(`indicator: ${indicator}`)
        }
    }
}

// --| Set Button Number --------------
function setButtonNumber(ctx, i) {
    const bgLum = lightOrDark(getBackground(i))

    if (bgLum.includes('dark')) {
        ctx.fillStyle = '#E8DA5E'
    } else {
        ctx.fillStyle = '#1A1B1D'
    }

    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'right'
    ctx.font = '10px serif'
    ctx.fillText(i, 78, 78)
    return ctx
}

function getIndicator(ctx, indicator) {
    ctx.font = '35px serif'

    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'center'
    ctx.fillStyle = '#627845'

    ctx.fillText(indicator, 43, 65)

    console.log(`indicator set: ${indicator}`)
}

// --| Get Text -----------------------
function getText(ctx, i, incText = '') {
    const text = incText === '' ? conf.touch[i].text : incText
    let useText

    console.log(`Touch Num: ${i} Inbound Text: ${text}`)

    if (text !== undefined && text !== '') {
        useText = text
    } else {
        useText = 'Dongle'
    }

    ctx.font = '15px serif'

    if (ctx.measureText(useText).width >= 80) {
        ctx.font = '12px serif'
    }

    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'center'

    ctx.fillText(useText, 43, 25)

    return useText
}

// --| Get Text -----------------------
function getTextArray(ctx, i, incText = []) {
    const text = incText.length === 0 ? conf.touch[i].text : incText
    let useText = text
    let textOffset = 0

    for (let i = 0; i < incText.length; i++) {
        const line = incText[i]
        useText = line
        ctx.font = '15px serif'

        if (ctx.measureText(useText).width >= 80) {
            ctx.font = '12px serif'
        }

        ctx.textBaseline = 'alphabetic'
        ctx.textAlign = 'center'

        ctx.fillText(useText, 43, 25 + textOffset)
        textOffset += 16
    }
    return ctx
}

// --| Get Background -----------------
function getBackground(i) {
    const endColor = conf.touch[i].color
    let useColor

    if (endColor !== '') {
        useColor = endColor
    } else {
        useColor = colors[i % colors.length]
    }

    return useColor
}

// --| Get Pressed Background ---------
function getPressedBackground(i) {
    const endColor = conf.touch[i].down_color
    let useColor

    if (endColor !== '') {
        useColor = endColor
    } else {
        useColor = colors[i % colors.length]
    }

    return useColor
}

// --| Get Font Color -----------------
function getFontColor(i) {
    const fontColor = conf.touch[i].text_color
    let useFontColor

    if (fontColor !== '') {
        useFontColor = fontColor
    } else {
        useFontColor = '#262626'
    }

    return useFontColor
}

// --| Get Font Down Color ------------
function getFontDownColor(i) {
    const fontColor = conf.touch[i].text_down_color
    let useFontColor

    if (fontColor !== '') {
        useFontColor = fontColor
    } else {
        useFontColor = '#ffffff'
    }

    return useFontColor
}

function closeMqttConnection() {
    try {
        if (mqttClient !== undefined) {
            const options = { retain: true }

            mqttClient.publish('loupedeck/outgoing', 'Closing Connection', options)
            mqttClient.unsubscribe('loupedeck')
            mqttClient.end()
            console.log('Mqtt client connection closed')
        }

        process.exit()
    } catch (error) {
        console.log(`Error closing Mqtt Client: ${error.message}`)
    }
}

process.on('SIGINT', () => {
    closeMqttConnection()
}) // CTRL+C
process.on('SIGQUIT', () => {
    closeMqttConnection()
}) // Keyboard quit
process.on('SIGTERM', () => {
    closeMqttConnection()
}) // `kill` command