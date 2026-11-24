import { useMemo, useState } from 'react'
import { useAssignableStaff } from '@/apis/queries/neotms.query'
import type { AssignableAttribute, AssignableStaff } from '@/apis/neotms.types'
import { RecordPicker, type PickerOption } from '@/shared/ui/RecordPicker'

/**
 * One eligible colleague as a picker row. `mgrId` is the subtitle - two people can share a name.
 *
 * Not exported, unlike `customerOption` next door: nothing outside this file builds one of these,
 * and exporting a non-component from a component file costs a fast-refresh warning for nothing.
 */
function assignableOption(row: AssignableStaff): PickerOption {
  return {
    id: row.id,
    title: row.name || row.mgrId,
    subtitle: row.name ? row.mgrId : null,
  }
}

interface Props {
  /** Which seat this picker fills. Decides both the list and the server's own check. */
  attribute: AssignableAttribute
  /** `<label htmlFor>` target; must be unique on the screen. */
  id: string
  label: string
  value: PickerOption | null
  onChange: (option: PickerOption | null) => void
  required?: boolean
  disabled?: boolean
}

/**
 * Pick the PM or the sales manager of a project, from the people who may hold that seat.
 *
 * ## The same control as the customer picker, filtering in a different place
 *
 * `CustomerPicker` searches the SERVER on each search, because there are more customers than a page
 * can hold. The eligible staff for one attribute is a short closed list - a handful to a few dozen
 * people - so it is fetched once and narrowed here. From the outside the two behave identically:
 * type, press search or Enter, pick a row, press change to choose again.
 *
 * The one deliberate difference is what an EMPTY keyword shows. The customer picker shows nothing
 * until you search, because "the first page of every customer" is a list nobody asked for; this one
 * shows everybody, because the whole point is to see who is eligible. Hiding a ten-name list behind
 * a search box would mean guessing a colleague's name to find out whether they are a PM.
 *
 * ## Why the list is not every staff member
 *
 * `prj_pm_id` and `prj_mgr_id` are refused by the server unless the named person carries the
 * matching attribute (`NEOTMS_USER_ATTRIBUTE_PM` / `_SALES_MANAGER`). A picker that offered
 * everybody would therefore be a picker most of whose entries produce a 400 - and the message would
 * arrive on save, after the form had been filled in, naming a colleague the user had every reason
 * to think was valid. Offering only the eligible people is how the two sides agree.
 */
export function StaffPicker({
  attribute,
  id,
  label,
  value,
  onChange,
  required = false,
  disabled = false,
}: Props) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  const staffQuery = useAssignableStaff(attribute)

  const options = useMemo(() => {
    const all = (staffQuery.data?.items ?? []).map(assignableOption)
    const needle = submitted.trim().toLowerCase()
    if (!needle) return all
    /*
     * Name and `mgrId` both, because both are how somebody is identified here - a search for
     * "kim" and a search for "kim3" are the same intention, and the second one is what you type
     * when there are three of them.
     */
    return all.filter(
      (option: PickerOption) =>
        option.title.toLowerCase().includes(needle) ||
        (option.subtitle ?? '').toLowerCase().includes(needle),
    )
  }, [staffQuery.data, submitted])

  return (
    <RecordPicker
      id={id}
      label={label}
      required={required}
      disabled={disabled}
      selected={value}
      options={options}
      isLoading={staffQuery.isLoading}
      error={staffQuery.error}
      keyword={keyword}
      onKeywordChange={setKeyword}
      onSearch={() => setSubmitted(keyword.trim())}
      onSelect={(option) => {
        onChange(option)
        if (!option) setSubmitted('')
      }}
      placeholder="이름 또는 사번"
      hint={
        staffQuery.isLoading || value
          ? undefined
          : options.length === 0
            ? submitted
              ? `'${submitted}' 로 찾은 담당자가 없습니다.`
              : '지정할 수 있는 담당자가 없습니다. 사용자 관리에서 먼저 권한을 지정해 주세요.'
            : undefined
      }
    />
  )
}
