import * as React from 'react'
import { IconDefinition } from "@fortawesome/free-solid-svg-icons"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"

/** A button to appear in the navigation (both, top bar or dropdown). */
export const NavButton: React.FC<{
  icon?: IconDefinition
  iconElement?: JSX.Element
  text?: string
  onClick?: React.MouseEventHandler<HTMLAnchorElement>
  title?: string
  href?: string
  inverted?: boolean
  disabled?: boolean
  className?: string
  /** aria-expanded, for a button that opens a menu. */
  expanded?: boolean
}> = ({icon, iconElement, text, onClick=()=>{}, title, href=undefined, inverted=false, disabled=false, className='', expanded}) => {
  // An <a> without href is not interactive content: it is skipped by Tab
  // and ignores focus(). The click-handled variant (the language opener,
  // the language menu items) is therefore a button: role, tab stop and
  // Enter / Space dispatching its click (React's onClick, bubbling kept).
  const asButton = href === undefined || disabled
  return <a
    className={`${className} nav-button btn${inverted?' btn-inverted':''}${disabled?' btn-disabled':''}`}
    onClick={ (ev) => {if(!disabled) onClick(ev) }}
    href={(!disabled) ? href : undefined} title={title}
    role={asButton ? "button" : undefined}
    tabIndex={disabled ? -1 : 0}
    aria-disabled={disabled || undefined}
    aria-expanded={expanded}
    onKeyDown={asButton ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.currentTarget.click() } } : undefined}>
    {iconElement ?? (icon && <FontAwesomeIcon icon={icon} />)}{text && <>&nbsp;{text}</>}
  </a>
}
