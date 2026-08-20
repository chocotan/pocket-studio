package daemon

import (
	"log"

	"remote-agent/internal/protocol"
)

// skill.* message handlers. Each handler does its work and replies with a
// result envelope that the server hub routes back to the requesting client
// by request_id (resolvePending), same as workspace/project CRUD.

func (d *Daemon) sendSkillCatalogResult(result protocol.SkillCatalogResult) {
	d.send <- protocol.NewEnvelope(protocol.TypeSkillCatalogDone, "daemon", result)
}

func (d *Daemon) sendCustomAgentResult(result protocol.CustomAgentResult) {
	d.send <- protocol.NewEnvelope(protocol.TypeCustomAgentResult, "daemon", result)
}

func (d *Daemon) sendSkillStoreResult(result protocol.SkillStoreResult) {
	d.send <- protocol.NewEnvelope(protocol.TypeSkillStoreDone, "daemon", result)
}

func (d *Daemon) sendSkillFileTreeResult(result protocol.SkillFileTreeResult) {
	d.send <- protocol.NewEnvelope(protocol.TypeSkillFileDone, "daemon", result)
}

func (d *Daemon) sendSkillFileContent(result protocol.SkillFileContent) {
	d.send <- protocol.NewEnvelope(protocol.TypeSkillFileDone, "daemon", result)
}

func (d *Daemon) sendSkillFileOpResult(result protocol.SkillFileOperationResult) {
	d.send <- protocol.NewEnvelope(protocol.TypeSkillFileDone, "daemon", result)
}

func (d *Daemon) handleSkillCatalogList(request protocol.SkillCatalogListRequest) {
	d.sendSkillCatalogResult(protocol.SkillCatalogResult{
		RequestID: request.RequestID,
		Skills:    listSkillCatalog(),
	})
}

func (d *Daemon) handleCustomAgentList(request protocol.CustomAgentListRequest) {
	d.sendCustomAgentResult(protocol.CustomAgentResult{
		RequestID: request.RequestID,
		Agents:    listCustomAgents(),
	})
}

func (d *Daemon) handleCustomAgentSave(request protocol.CustomAgentSaveRequest) {
	agent, err := upsertCustomAgent(request.Agent)
	if err != nil {
		d.sendCustomAgentResult(protocol.CustomAgentResult{RequestID: request.RequestID, Error: err.Error()})
		return
	}
	log.Printf("custom agents: saved %s (base %s)", agent.ID, agent.BaseAgent)
	d.sendCustomAgentResult(protocol.CustomAgentResult{RequestID: request.RequestID, Agent: &agent})
}

func (d *Daemon) handleCustomAgentDelete(request protocol.CustomAgentDeleteRequest) {
	if err := deleteCustomAgent(request.AgentID); err != nil {
		d.sendCustomAgentResult(protocol.CustomAgentResult{RequestID: request.RequestID, Error: err.Error()})
		return
	}
	log.Printf("custom agents: deleted %s", request.AgentID)
	d.sendCustomAgentResult(protocol.CustomAgentResult{RequestID: request.RequestID, Deleted: true})
}

func (d *Daemon) handleSkillStoreInstall(request protocol.SkillStoreInstallRequest) {
	var (
		summary protocol.SkillSummary
		err     error
	)
	switch request.Source {
	case "git":
		summary, err = installSkillFromGit(request.Ref, request.Name)
	case "local":
		summary, err = installSkillFromLocal(request.Ref, request.Name)
	default:
		err = errSkillNotManaged // distinct enough message below
		d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Error: "source must be \"git\" or \"local\""})
		return
	}
	if err != nil {
		d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Error: err.Error()})
		return
	}
	log.Printf("skill store: installed %s from %s", summary.Name, request.Source)
	d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Skill: &summary})
}

func (d *Daemon) handleSkillStoreRemove(request protocol.SkillStoreRemoveRequest) {
	if err := removeStoreSkill(request.Name); err != nil {
		d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Error: err.Error()})
		return
	}
	log.Printf("skill store: removed %s", request.Name)
	d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Removed: true})
}

func (d *Daemon) handleSkillStoreUpgrade(request protocol.SkillStoreUpgradeRequest) {
	summary, err := upgradeStoreSkill(request.Name, request.Force)
	if err != nil {
		d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Error: err.Error()})
		return
	}
	d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Skill: &summary})
}

func (d *Daemon) handleSkillCreate(request protocol.SkillCreateRequest) {
	location := request.Location
	if location == "" {
		location = "store"
	}
	summary, err := createSkill(request.Name, request.Description, location)
	if err != nil {
		d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Error: err.Error()})
		return
	}
	log.Printf("skill store: created %s (%s)", summary.Name, location)
	d.sendSkillStoreResult(protocol.SkillStoreResult{RequestID: request.RequestID, Skill: &summary})
}

func (d *Daemon) handleSkillFileTree(request protocol.SkillFileTreeRequest) {
	root, entries, err := listSkillFiles(request.Name)
	if err != nil {
		d.sendSkillFileTreeResult(protocol.SkillFileTreeResult{RequestID: request.RequestID, Error: err.Error()})
		return
	}
	d.sendSkillFileTreeResult(protocol.SkillFileTreeResult{
		RequestID: request.RequestID,
		Name:      request.Name,
		Root:      root,
		Entries:   entries,
	})
}

func (d *Daemon) handleSkillFileRead(request protocol.SkillFileReadRequest) {
	result, err := readSkillFile(request.Name, request.Path)
	result.RequestID = request.RequestID
	if err != nil {
		result.Error = err.Error()
	}
	d.sendSkillFileContent(result)
}

func (d *Daemon) handleSkillFileWrite(request protocol.SkillFileWriteRequest) {
	result, err := writeSkillFile(request)
	result.RequestID = request.RequestID
	if err != nil {
		result.Error = err.Error()
	}
	d.sendSkillFileOpResult(result)
}

func (d *Daemon) handleSkillFileCreate(request protocol.SkillFileCreateRequest) {
	result, err := createSkillFile(request)
	result.RequestID = request.RequestID
	if err != nil {
		result.Error = err.Error()
	}
	d.sendSkillFileOpResult(result)
}

func (d *Daemon) handleSkillFileRename(request protocol.SkillFileRenameRequest) {
	result, err := renameSkillFile(request)
	result.RequestID = request.RequestID
	if err != nil {
		result.Error = err.Error()
	}
	d.sendSkillFileOpResult(result)
}

func (d *Daemon) handleSkillFileDelete(request protocol.SkillFileDeleteRequest) {
	result, err := deleteSkillFile(request)
	result.RequestID = request.RequestID
	if err != nil {
		result.Error = err.Error()
	}
	d.sendSkillFileOpResult(result)
}

func (d *Daemon) handleSkillValidate(request protocol.SkillValidateRequest) {
	result, err := validateSkill(request.Name)
	result.RequestID = request.RequestID
	if err != nil {
		result.Error = err.Error()
	}
	d.sendSkillFileOpResult(result)
}
