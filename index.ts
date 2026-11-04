import { createCliRenderer } from "@opentui/core"
import { mount } from "./src/app.ts"

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  screenMode: "alternate-screen",
})

mount(renderer)
