import { useEffect } from 'react'

import { AppShell } from '@/app/app-shell'
import { mountApp } from '@/app/mount'
import { ChyModPage } from '@/features/chymod/chymod-page'
import '@/styles/globals.css'

function ChyModEntry() {
  useEffect(() => {
    document.title = `ChyMOD | ｽﾀｯｸﾁｬﾝ`
  }, [])
  return (
    <AppShell current="chymod" surfaceName="ChyMOD" rootHref="../">
      <ChyModPage />
    </AppShell>
  )
}

mountApp(<ChyModEntry />)
